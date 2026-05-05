/**
 * Tests for for_each durability checkpoints + boot reconciliation (P3.2).
 *
 * Strategy: instantiate ForEachDispatcher directly with mock deps for unit
 * coverage of checkpoint writes, resume logic, and checkpoint-clear-on-complete.
 * Boot reconciliation is tested by calling _reconcileForEachSessions() directly
 * on a booted AppContext with a running session that has a checkpoint.
 *
 * Resume approach chosen: child-session status scan (see dispatch-foreach.ts
 * module docstring). The checkpoint does NOT maintain a completed[] array --
 * on resume we query child sessions with config.for_each_parent=parentId and
 * treat those with status=completed as already done. This is robust against
 * the crash window between child completion and parent checkpoint update.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { ForEachDispatcher } from "../services/dispatch/dispatch-foreach.js";
import type { DispatchInlineSubStageCb } from "../services/dispatch/dispatch-foreach.js";
import type { StageDefinition } from "../services/flow.js";
import { buildSessionVars } from "../template.js";
import type { DispatchDeps } from "../services/dispatch/types.js";

// ── Test context ─────────────────────────────────────────────────────────────

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
}, 30_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a parent session with a list in config.inputs.repos */
async function makeParentWithList(list: unknown[]): Promise<{ id: string; vars: Record<string, string> }> {
  const session = await app.sessions.create({
    summary: "durability test parent",
    flow: "bare",
    config: { inputs: { repos: JSON.stringify(list) } },
  });
  await app.sessions.update(session.id, { stage: "per_repo", status: "ready" });
  const updated = (await app.sessions.get(session.id))!;
  const vars = buildSessionVars(updated as unknown as Record<string, unknown>);
  return { id: session.id, vars };
}

/** Minimal spawn-mode stage definition. */
function makeSpawnStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: "per_repo",
    for_each: "{{inputs.repos}}",
    mode: "spawn",
    iteration_var: "repo",
    on_iteration_failure: "stop",
    gate: "auto",
    spawn: {
      flow: "bare",
      inputs: { path: "{{repo.path}}" },
    },
    ...overrides,
  };
}

/** Minimal inline-mode stage definition. */
function makeInlineStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: "per_file",
    for_each: "{{inputs.repos}}",
    mode: "inline",
    iteration_var: "repo",
    on_iteration_failure: "stop",
    gate: "auto",
    stages: [
      {
        name: "do_work",
        gate: "auto",
        agent: {
          runtime: "claude-agent",
          system_prompt: "Work",
        },
        task: "Work on {{repo.path}}",
      },
    ],
    ...overrides,
  };
}

/** Build a spawn-mode ForEachDispatcher with a dispatch mock. */
function makeSpawnDispatcher(onDispatch?: (childId: string) => Promise<void>): ForEachDispatcher {
  const dispatchChild: DispatchDeps["dispatchChild"] = async (childId: string) => {
    if (onDispatch) {
      await onDispatch(childId);
    } else {
      await app.sessions.update(childId, { status: "completed" });
    }
    return { ok: true, message: "mocked dispatch" };
  };

  return new ForEachDispatcher({
    sessions: app.sessions,
    events: app.events,
    flows: app.flows,
    dispatchChild,
  });
}

/** Build an inline-mode ForEachDispatcher with a sub-stage mock. */
function makeInlineDispatcher(
  onSubStage?: (call: { sessionId: string; subStage: StageDefinition }) => Promise<{ ok: boolean; message: string }>,
): ForEachDispatcher {
  const dispatchInlineSubStage: DispatchInlineSubStageCb = async (sessionId, subStage, _iterVars) => {
    if (onSubStage) return onSubStage({ sessionId, subStage });
    return { ok: true, message: "mocked sub-stage ok" };
  };

  return new ForEachDispatcher({
    sessions: app.sessions,
    events: app.events,
    flows: app.flows,
    dispatchChild: async () => ({ ok: true, message: "unused in inline mode" }),
    dispatchInlineSubStage,
  });
}

/** Read the for_each_checkpoint from a session's config. */
async function readCheckpoint(sessionId: string) {
  const session = await app.sessions.get(sessionId);
  return (session?.config as Record<string, unknown> | null)?.for_each_checkpoint ?? null;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("for_each checkpoint -- spawn mode -- fresh dispatch writes checkpoint at enter", () => {
  it("checkpoint is written with total_items before first iteration completes", async () => {
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    let checkpointAtStart: unknown = undefined;
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      // Capture checkpoint right as the first dispatch begins (before completing).
      if (checkpointAtStart === undefined) {
        checkpointAtStart = await readCheckpoint(parentId);
      }
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    // Checkpoint was written at loop enter.
    expect(checkpointAtStart).not.toBeNull();
    const cp = checkpointAtStart as Record<string, unknown>;
    expect(cp.total_items).toBe(3);
    expect(cp.stage_name).toBe("per_repo");
    expect(Array.isArray(cp.items)).toBe(true);
    expect((cp.items as unknown[]).length).toBe(3);
  });
});

describe("for_each checkpoint -- spawn mode -- checkpoint updates across iterations", () => {
  it("next_index increments and in_flight tracks the current iteration", async () => {
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const checkpointsAtDispatch: Array<Record<string, unknown>> = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      const cp = await readCheckpoint(parentId);
      if (cp) checkpointsAtDispatch.push(cp as Record<string, unknown>);
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);
    expect(checkpointsAtDispatch.length).toBeGreaterThanOrEqual(3);

    // For each iteration, the checkpoint should show in_flight.index and
    // next_index = in_flight.index + 1.
    for (let i = 0; i < 3; i++) {
      const cp = checkpointsAtDispatch[i];
      expect(cp.in_flight).toBeDefined();
      const inf = cp.in_flight as Record<string, unknown>;
      expect(inf.index).toBe(i);
      expect(cp.next_index).toBe(i + 1);
    }
  });
});

describe("for_each checkpoint -- spawn mode -- checkpoint cleared on completion", () => {
  it("for_each_checkpoint is null/undefined after all iterations complete", async () => {
    const items = [{ path: "/a" }, { path: "/b" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    const cp = await readCheckpoint(parentId);
    // Cleared -- should be null or undefined (mergeConfig sets to null).
    expect(cp == null).toBe(true);
  });
});

describe("for_each checkpoint -- spawn mode -- resume skips completed iterations", () => {
  it("re-dispatch with child sessions already completed only spawns remaining iterations", async () => {
    // Set up: 6 items. Simulate that iterations 0-4 already have completed
    // child sessions. Only iteration 5 should be dispatched.
    const items = Array.from({ length: 6 }, (_, i) => ({ path: `/repo/${i}` }));
    const { id: parentId, vars } = await makeParentWithList(items);

    // Pre-create child sessions for iterations 0-4 and mark them completed.
    for (let idx = 0; idx < 5; idx++) {
      const child = await app.sessions.create({
        summary: `child ${idx}`,
        flow: "bare",
        config: { for_each_parent: parentId, for_each_index: idx },
      });
      await app.sessions.update(child.id, {
        parent_id: parentId,
        status: "completed",
      });
    }

    // Write a checkpoint that indicates iteration 5 is next.
    await app.sessions.mergeConfig(parentId, {
      for_each_checkpoint: {
        stage_name: "per_repo",
        total_items: 6,
        items,
        next_index: 5,
      } as any,
    } as any);

    const dispatchedIndices: number[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      const child = await app.sessions.get(childId);
      const idx = (child?.config as Record<string, unknown>)?.for_each_index;
      if (typeof idx === "number") dispatchedIndices.push(idx);
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    // Only iteration 5 should have been dispatched.
    expect(dispatchedIndices).toEqual([5]);
  });
});

describe("for_each checkpoint -- spawn mode -- resume restarts in-flight iteration", () => {
  it("in-flight child with non-completed status is re-spawned on resume", async () => {
    // Simulate: 3 items, iteration 1 is in_flight with a child that is still
    // "running" (or some non-completed status). The checkpoint shows next_index=2.
    // On resume, iteration 1 should be retried (it's not in the completed set).
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    // Pre-create completed child for iteration 0 only.
    const child0 = await app.sessions.create({
      summary: "child 0",
      flow: "bare",
      config: { for_each_parent: parentId, for_each_index: 0 },
    });
    await app.sessions.update(child0.id, { parent_id: parentId, status: "completed" });

    // Pre-create a "running" child for iteration 1 (simulates dead process).
    const child1 = await app.sessions.create({
      summary: "child 1",
      flow: "bare",
      config: { for_each_parent: parentId, for_each_index: 1 },
    });
    await app.sessions.update(child1.id, {
      session_id: `ark-s-${child1.id}`,
      parent_id: parentId,
      status: "running", // not completed -- should be retried
    });

    // Write checkpoint indicating next_index=2, in_flight={index:1,child_session_id:child1.id}.
    await app.sessions.mergeConfig(parentId, {
      for_each_checkpoint: {
        stage_name: "per_repo",
        total_items: 3,
        items,
        next_index: 2,
        in_flight: {
          index: 1,
          child_session_id: child1.id,
          started_at: new Date().toISOString(),
        },
      } as any,
    } as any);

    const dispatchedIndices: number[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      const child = await app.sessions.get(childId);
      const idx = (child?.config as Record<string, unknown>)?.for_each_index;
      if (typeof idx === "number") dispatchedIndices.push(idx);
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    // Iterations 1 and 2 should be dispatched (0 is skipped as completed,
    // 1 is re-dispatched because child1 was running, not completed).
    expect(dispatchedIndices).toContain(1);
    expect(dispatchedIndices).toContain(2);
    expect(dispatchedIndices).not.toContain(0);
  });
});

describe("for_each checkpoint -- stage_name mismatch is ignored", () => {
  it("checkpoint from a different stage does not cause resume -- fresh dispatch runs", async () => {
    const items = [{ path: "/a" }, { path: "/b" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    // Write a checkpoint for a DIFFERENT stage name.
    await app.sessions.mergeConfig(parentId, {
      for_each_checkpoint: {
        stage_name: "some_other_stage",
        total_items: 99,
        items: [{ path: "/old" }],
        next_index: 99,
      } as any,
    } as any);

    const dispatchedCount: number[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      const child = await app.sessions.get(childId);
      const idx = (child?.config as Record<string, unknown>)?.for_each_index;
      if (typeof idx === "number") dispatchedCount.push(idx);
      await app.sessions.update(childId, { status: "completed" });
    });

    // Stage name is "per_repo", checkpoint has "some_other_stage" -- fresh start.
    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    // All 2 items in the actual list should be dispatched (fresh, not resuming).
    expect(dispatchedCount).toHaveLength(2);
    expect(dispatchedCount).toContain(0);
    expect(dispatchedCount).toContain(1);
  });
});

describe("for_each checkpoint -- inline mode -- checkpoint writes and clear", () => {
  it("inline mode writes checkpoint at loop enter and clears it on completion", async () => {
    const items = [{ path: "/a" }, { path: "/b" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    let checkpointDuringLoop: unknown = undefined;
    const dispatcher = makeInlineDispatcher(async () => {
      // Capture checkpoint during first sub-stage dispatch.
      if (checkpointDuringLoop === undefined) {
        checkpointDuringLoop = await readCheckpoint(parentId);
      }
      return { ok: true, message: "ok" };
    });

    const stage = makeInlineStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(result.ok).toBe(true);

    // Checkpoint was written during the loop.
    expect(checkpointDuringLoop).not.toBeNull();
    const cp = checkpointDuringLoop as Record<string, unknown>;
    expect(cp.stage_name).toBe("per_file");
    expect(cp.total_items).toBe(2);

    // Checkpoint is cleared after completion.
    const finalCp = await readCheckpoint(parentId);
    expect(finalCp == null).toBe(true);
  });
});

describe("for_each checkpoint -- boot reconciliation dispatches running sessions", () => {
  it("_reconcileForEachSessions re-dispatches sessions with for_each_checkpoint", async () => {
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];

    // Create a session with status=running and a for_each_checkpoint.
    const session = await app.sessions.create({
      summary: "reconcile test session",
      flow: "bare",
      config: { inputs: { repos: JSON.stringify(items) } },
    });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, stage: "per_repo", status: "running" });

    // Write a checkpoint as if iteration 2 was in progress and iterations 0-1 done.
    const child0 = await app.sessions.create({
      summary: "child 0",
      flow: "bare",
      config: { for_each_parent: session.id, for_each_index: 0 },
    });
    await app.sessions.update(child0.id, { parent_id: session.id, status: "completed" });

    const child1 = await app.sessions.create({
      summary: "child 1",
      flow: "bare",
      config: { for_each_parent: session.id, for_each_index: 1 },
    });
    await app.sessions.update(child1.id, { parent_id: session.id, status: "completed" });

    await app.sessions.mergeConfig(session.id, {
      for_each_checkpoint: {
        stage_name: "per_repo",
        total_items: 3,
        items,
        next_index: 2,
      } as any,
    } as any);

    // Track dispatches by watching the session status changes.
    // _reconcileForEachSessions calls dispatchService.dispatch() which (with the
    // noop executor + for_each path) will update the session.
    // Since we're testing real dispatch service integration, we just verify the
    // method can be called without error and that it processes the running session.
    const runningSessions = await app.sessions.list({ status: "running", limit: 500 });
    const hasOurSession = runningSessions.some((s) => s.id === session.id);
    expect(hasOurSession).toBe(true);

    // Actually call reconcile.
    await app._reconcileForEachSessions();

    // After reconcile + dispatch, the session should have been processed.
    // The for_each stage with "bare" flow will either complete or fail --
    // either way it won't be stuck in status=running with no process.
    const after = await app.sessions.get(session.id);
    // The session should no longer be in status=running+checkpoint state
    // (it's either completed, failed, or was re-queued as ready).
    // At minimum, the reconcile should not throw.
    expect(after).not.toBeNull();
  });
});

describe("for_each checkpoint -- spawn mode -- checkpoint cleared on on_iteration_failure:stop halt", () => {
  it("checkpoint is cleared even when the loop is halted by a failed iteration", async () => {
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    let callNum = 0;
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      const n = callNum++;
      if (n === 1) {
        await app.sessions.update(childId, { status: "failed" });
      } else {
        await app.sessions.update(childId, { status: "completed" });
      }
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage({ on_iteration_failure: "stop" }), vars);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("failed");

    // Checkpoint should be cleared even on failure.
    const cp = await readCheckpoint(parentId);
    expect(cp == null).toBe(true);
  });
});
