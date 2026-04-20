/**
 * Subagent spawning -- independent child sessions with their own model/agent.
 *
 * Extracted from stage-orchestrator.ts. Unlike fork (which copies the parent's
 * config), subagents can use different models and agents for cost optimization
 * or specialization.
 */

import type { AppContext } from "../app.js";
import * as flow from "../state/flow.js";

/**
 * Spawn a subagent -- an independent child session with its own model/agent.
 * Unlike fork (which copies the parent's config), subagents can use different
 * models and agents for cost optimization or specialization.
 */
export function spawnSubagent(
  app: AppContext,
  parentId: string,
  opts: {
    task: string;
    agent?: string;
    model?: string;
    group_name?: string;
    extensions?: string[];
  },
): { ok: boolean; sessionId?: string; message: string } {
  const parent = app.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent session not found" };

  const session = app.sessions.create({
    summary: opts.task,
    repo: parent.repo || undefined,
    flow: "quick",
    compute_name: parent.compute_name || undefined,
    workdir: parent.workdir || undefined,
    group_name: opts.group_name ?? parent.group_name ?? undefined,
    config: {
      parent_id: parentId,
      subagent: true,
      model_override: opts.model,
      extensions: opts.extensions,
    },
  });

  const agentName = opts.agent ?? parent.agent;
  app.sessions.update(session.id, { agent: agentName, parent_id: parentId });

  // Set first stage so the subagent is dispatchable
  const firstStage = flow.getFirstStage(app, "quick");
  if (firstStage) {
    app.sessions.update(session.id, { stage: firstStage, status: "ready" });
  }

  app.events.log(session.id, "subagent_spawned", {
    actor: "system",
    data: { parent_id: parentId, task: opts.task, agent: agentName, model: opts.model },
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
    model?: string;
  }>,
): Promise<{ ok: boolean; sessionIds: string[]; message: string }> {
  const ids: string[] = [];
  for (const t of tasks) {
    const result = spawnSubagent(app, parentId, t);
    if (result.ok && result.sessionId) {
      ids.push(result.sessionId);
    }
  }

  // Break cycle between subagents.ts and dispatch.ts via dynamic import.
  const { dispatch } = await import("./dispatch.js");
  await Promise.allSettled(ids.map((id) => dispatch(app, id).catch(() => {})));

  return { ok: true, sessionIds: ids, message: `${ids.length} subagents spawned and dispatched` };
}
