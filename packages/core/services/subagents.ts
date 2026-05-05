/**
 * Subagent spawning -- independent child sessions with their own model/agent.
 *
 * Extracted from stage-orchestrator.ts. Unlike fork (which copies the parent's
 * config), subagents can use different models and agents for cost optimization
 * or specialization.
 */

import type { AppContext } from "../app.js";
import * as flow from "./flow.js";
import { logWarn } from "../observability/structured-log.js";
import { markDispatchFailedShared } from "./session-dispatch-listeners.js";

/**
 * Spawn a subagent -- an independent child session with its own agent.
 * Unlike fork (which copies the parent's config), subagents can pick a
 * different agent for specialization. Per-subsession model selection now
 * flows through the agent definition (or an inline agent on the flow
 * stage) -- dispatch no longer reads a session-level `model_override`.
 */
export async function spawnSubagent(
  app: AppContext,
  parentId: string,
  opts: {
    task: string;
    agent?: string;
    group_name?: string;
    extensions?: string[];
  },
): Promise<{ ok: boolean; sessionId?: string; message: string }> {
  const parent = await app.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent session not found" };

  const session = await app.sessions.create({
    summary: opts.task,
    repo: parent.repo || undefined,
    flow: "quick",
    compute_name: parent.compute_name || undefined,
    workdir: parent.workdir || undefined,
    group_name: opts.group_name ?? parent.group_name ?? undefined,
    config: {
      parent_id: parentId,
      subagent: true,
      extensions: opts.extensions,
    },
  });

  const agentName = opts.agent ?? parent.agent;
  await app.sessions.update(session.id, { agent: agentName, parent_id: parentId });

  // Set first stage so the subagent is dispatchable
  const firstStage = flow.getFirstStage(app, "quick");
  if (firstStage) {
    await app.sessions.update(session.id, { stage: firstStage, status: "ready" });
  }

  await app.events.log(session.id, "subagent_spawned", {
    actor: "system",
    data: { parent_id: parentId, task: opts.task, agent: agentName },
  });

  app.sessionService.emitSessionCreated(session.id);
  return { ok: true, sessionId: session.id, message: `Subagent ${session.id} spawned` };
}

/**
 * Spawn multiple subagents in parallel and optionally wait for all to complete.
 */
export async function spawnParallelSubagents(
  app: AppContext,
  parentId: string,
  tasks: Array<{
    task: string;
    agent?: string;
  }>,
): Promise<{ ok: boolean; sessionIds: string[]; message: string }> {
  const ids: string[] = [];
  for (const t of tasks) {
    const result = await spawnSubagent(app, parentId, t);
    if (result.ok && result.sessionId) {
      ids.push(result.sessionId);
    }
  }

  // TODO(follow-up): add retry strategy + observable dispatch status for
  // subagents. Today we log + persist a dispatch_failed event on the child
  // session so the parent flow (and operators tailing events) can see which
  // subagent failed to launch; a caller that currently only reads the
  // returned sessionIds still has no signal that one of them is wedged.
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        const r = await app.dispatchService.dispatch(id);
        if (r && r.ok === false) {
          // Non-throw failure path: pre-fix `{ok:false}` was silently
          // dropped (only thrown errors made it into the catch). Use the
          // shared helper so the dispatch_failed event AND the status flip
          // to `failed` happen together.
          const reason = r.message ?? "subagent dispatch returned ok:false";
          logWarn("session", `subagents: dispatch returned ok:false (parent=${parentId}, child=${id}): ${reason}`, {
            parentId,
            childId: id,
            reason,
          });
          await markDispatchFailedShared(app.sessions, app.events, id, reason);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logWarn("session", `subagents: dispatch failed for child session (parent=${parentId}, child=${id})`, {
          parentId,
          childId: id,
          error: reason,
        });
        // Use markDispatchFailedShared so the failure carries the same
        // shape as kickDispatch + handoff -- event row + status=failed
        // (lenient against an already-terminal status).
        await markDispatchFailedShared(app.sessions, app.events, id, reason);
      }
    }),
  );

  return { ok: true, sessionIds: ids, message: `${ids.length} subagents spawned and dispatched` };
}
