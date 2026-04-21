/**
 * Fork / join / fan-out -- creates sibling child sessions and coordinates their rejoin.
 *
 * Extracted from stage-orchestrator.ts. Uses dynamic imports for dispatch/advance
 * to break circular dependencies with those modules.
 */

import { randomUUID } from "crypto";

import type { AppContext } from "../app.js";
import * as flow from "../state/flow.js";

type SessionOpResult = Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;

// ── Fork ────────────────────────────────────────────────────────────────────

export async function fork(
  app: AppContext,
  parentId: string,
  task: string,
  opts?: {
    agent?: string;
    dispatch?: boolean;
  },
): SessionOpResult {
  const parent = await app.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent not found" };

  const forkGroup = parent.fork_group ?? randomUUID().slice(0, 8);
  if (!parent.fork_group) await app.sessions.update(parentId, { fork_group: forkGroup });

  const child = await app.sessions.create({
    ticket: parent.ticket || undefined,
    summary: task,
    repo: parent.repo || undefined,
    flow: "bare",
    compute_name: parent.compute_name || undefined,
    workdir: parent.workdir || undefined,
  });

  await app.sessions.update(child.id, {
    parent_id: parentId,
    fork_group: forkGroup,
    stage: parent.stage,
    status: "ready",
  });
  await app.events.log(child.id, "session_forked", {
    stage: parent.stage,
    actor: "user",
    data: { parent_id: parentId, fork_group: forkGroup, task },
  });

  if (opts?.dispatch !== false) {
    // Dynamic import avoids cycle with dispatch.ts (which calls fork via dispatchFork).
    const { dispatch } = await import("./dispatch.js");
    await dispatch(app, child.id);
  }
  return { ok: true, sessionId: child.id };
}

// ── Join ────────────────────────────────────────────────────────────────────

export async function joinFork(
  app: AppContext,
  parentId: string,
  force = false,
): Promise<{ ok: boolean; message: string }> {
  const children = await app.sessions.getChildren(parentId);
  if (!children.length) return { ok: false, message: "No children" };

  const notDone = children.filter((c) => c.status !== "completed");
  if (notDone.length && !force) {
    return { ok: false, message: `${notDone.length} children not done` };
  }

  await app.events.log(parentId, "fork_joined", { actor: "user", data: { children: children.length } });
  await app.sessions.update(parentId, { status: "ready", fork_group: null });
  const { advance } = await import("./stage-advance.js");
  return await advance(app, parentId, true);
}

/**
 * Check if a parent session can auto-join after a child completes or fails.
 * Returns true if the parent was advanced (all children are done).
 */
export async function checkAutoJoin(app: AppContext, childSessionId: string): Promise<boolean> {
  const child = await app.sessions.get(childSessionId);
  if (!child?.parent_id) return false;

  const parent = await app.sessions.get(child.parent_id);
  if (!parent) return false;
  if (parent.status !== "waiting") return false;

  const children = await app.sessions.getChildren(parent.id);
  const allDone = children.every((c) => c.status === "completed" || c.status === "failed");
  if (!allDone) return false;

  const failed = children.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    await app.events.log(parent.id, "fan_out_partial_failure", {
      actor: "system",
      data: { failed: failed.map((f) => f.id), total: children.length },
    });
  }

  await app.events.log(parent.id, "auto_join", {
    actor: "system",
    data: { children: children.length, failed: failed.length },
  });
  await app.sessions.update(parent.id, { status: "ready", fork_group: null });
  const { advance } = await import("./stage-advance.js");
  await advance(app, parent.id, true);
  return true;
}

// ── Fan-out ─────────────────────────────────────────────────────────────────

interface FanOutTask {
  summary: string;
  agent?: string;
  flow?: string;
}

export async function fanOut(
  app: AppContext,
  parentId: string,
  opts: { tasks: FanOutTask[] },
): Promise<{ ok: boolean; childIds?: string[]; message?: string }> {
  const parent = await app.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent session not found" };
  if (opts.tasks.length === 0) return { ok: false, message: "No tasks provided" };

  const forkGroup = randomUUID().slice(0, 8);
  const childIds: string[] = [];

  for (const task of opts.tasks) {
    const child = await app.sessions.create({
      summary: task.summary,
      repo: parent.repo || undefined,
      flow: task.flow ?? "bare",
      compute_name: parent.compute_name || undefined,
      workdir: parent.workdir || undefined,
      group_name: parent.group_name || undefined,
    });
    // Set first stage so child is dispatchable
    const childFlow = task.flow ?? "bare";
    const firstStage = flow.getFirstStage(app, childFlow);
    await app.sessions.update(child.id, {
      parent_id: parentId,
      fork_group: forkGroup,
      agent: task.agent ?? null,
      stage: firstStage ?? null,
      status: "ready",
    });
    childIds.push(child.id);
  }

  // Parent waits for children
  await app.sessions.update(parentId, { status: "waiting", fork_group: forkGroup });
  await app.events.log(parentId, "fan_out", {
    actor: "system",
    data: { childCount: childIds.length, forkGroup },
  });

  return { ok: true, childIds };
}
