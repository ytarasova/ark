/**
 * Tests for per-iteration observability rollup (P3.3).
 *
 * Covers:
 *   - Enriched for_each_iteration_complete event payload (duration_ms, cost_usd,
 *     exit_status, index) for both spawn and inline modes.
 *   - Cost attribution across multiple iterations.
 *   - Average duration calculation from event payloads.
 *   - In-flight detection via checkpoint in_flight pointer.
 *   - Rollup helper functions that the CLI uses for session show.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { ForEachDispatcher } from "../services/dispatch/dispatch-foreach.js";
import type { DispatchInlineSubStageCb } from "../services/dispatch/dispatch-foreach.js";
import type { StageDefinition } from "../state/flow.js";
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

/** Create a parent session with a list in config.inputs. */
async function makeParentWithList(list: unknown[]): Promise<{ id: string; vars: Record<string, string> }> {
  const session = await app.sessions.create({
    summary: "observability test parent",
    flow: "bare",
    config: { inputs: { items: JSON.stringify(list) } },
  });
  await app.sessions.update(session.id, { stage: "per_item", status: "ready" });
  const updated = (await app.sessions.get(session.id))!;
  const vars = buildSessionVars(updated as unknown as Record<string, unknown>);
  return { id: session.id, vars };
}

/** Minimal spawn-mode stage. */
function makeSpawnStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: "per_item",
    for_each: "{{inputs.items}}",
    mode: "spawn",
    iteration_var: "item",
    on_iteration_failure: "stop",
    gate: "auto",
    spawn: {
      flow: "bare",
      inputs: { val: "{{item.val}}" },
    },
    ...overrides,
  };
}

/** Minimal inline-mode stage. */
function makeInlineStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: "per_item",
    for_each: "{{inputs.items}}",
    mode: "inline",
    iteration_var: "item",
    on_iteration_failure: "stop",
    gate: "auto",
    stages: [
      {
        name: "do_work",
        gate: "auto",
        agent: {
          runtime: "claude-agent",
          system_prompt: "Process item",
        },
        task: "Process {{item.val}}",
      },
    ],
    ...overrides,
  };
}

/** Build a spawn-mode dispatcher. */
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

/** Build an inline-mode dispatcher. */
function makeInlineDispatcher(
  onSubStage?: (call: {
    sessionId: string;
    subStage: StageDefinition;
    iterVars: Record<string, string>;
  }) => Promise<{ ok: boolean; message: string }>,
): ForEachDispatcher {
  const dispatchInlineSubStage: DispatchInlineSubStageCb = async (sessionId, subStage, iterVars) => {
    if (onSubStage) return onSubStage({ sessionId, subStage, iterVars });
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

/** Inject a synthetic hook_status event carrying total_cost_usd for a session. */
async function injectCostEvent(sessionId: string, costUsd: number, hookName = "SessionEnd"): Promise<void> {
  await app.events.log(sessionId, "hook_status", {
    actor: "hook",
    data: {
      hook_event_name: hookName,
      total_cost_usd: costUsd,
      session_id: sessionId,
    },
  });
}

/** Read all for_each_iteration_complete events for a session. */
async function readIterCompleteEvents(sessionId: string): Promise<Array<Record<string, unknown>>> {
  const evts = await app.events.list(sessionId, { type: "for_each_iteration_complete" });
  return evts.map((e) => (e.data ?? {}) as Record<string, unknown>);
}

/** Read the for_each_checkpoint from a session's config. */
async function readCheckpoint(sessionId: string): Promise<Record<string, unknown> | null> {
  const session = await app.sessions.get(sessionId);
  const cp = (session?.config as Record<string, unknown> | null)?.for_each_checkpoint;
  return (cp as Record<string, unknown> | null | undefined) ?? null;
}

// ── Tests: spawn mode enriched event ─────────────────────────────────────────

describe("for_each observability -- spawn mode -- enriched iteration_complete event", () => {
  it("emits for_each_iteration_complete with index, exit_status, duration_ms, cost_usd", async () => {
    const items = [{ val: "alpha" }, { val: "beta" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
      // Simulate the child generating a cost event on itself.
      await injectCostEvent(childId, 0.15, "SessionEnd");
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    const iterEvents = await readIterCompleteEvents(parentId);
    expect(iterEvents).toHaveLength(2);

    // Both events must have the required enriched fields.
    for (const evt of iterEvents) {
      expect(typeof evt.index).toBe("number");
      expect(evt.exit_status).toBe("completed");
      expect(typeof evt.duration_ms).toBe("number");
      expect((evt.duration_ms as number) >= 0).toBe(true);
      expect(typeof evt.cost_usd).toBe("number");
      expect((evt.cost_usd as number) >= 0).toBe(true);
      // childId must be present in spawn mode.
      expect(typeof evt.childId).toBe("string");
    }
  });

  it("event indices match iteration order (0, 1, 2 for 3 items)", async () => {
    const items = [{ val: "x" }, { val: "y" }, { val: "z" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    const iterEvents = await readIterCompleteEvents(parentId);
    expect(iterEvents).toHaveLength(3);
    const indices = iterEvents.map((e) => e.index);
    expect(indices).toEqual([0, 1, 2]);
  });
});

// ── Tests: cost attribution across iterations ─────────────────────────────────

describe("for_each observability -- spawn mode -- cost attribution across 3 iterations", () => {
  it("each iteration's cost_usd reflects the child's hook_status events", async () => {
    const items = [{ val: "a" }, { val: "b" }, { val: "c" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    // Each child has a different cost.
    const childCosts = [0.1, 0.2, 0.3];
    let callNum = 0;

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
      await injectCostEvent(childId, childCosts[callNum], "SessionEnd");
      callNum++;
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    const iterEvents = await readIterCompleteEvents(parentId);
    expect(iterEvents).toHaveLength(3);

    // Each event's cost_usd should match the injected cost (within float tolerance).
    const costs = iterEvents.map((e) => e.cost_usd as number);
    // Sort by index to ensure stable comparison.
    const sortedByIndex = iterEvents.sort((a, b) => (a.index as number) - (b.index as number));
    const sortedCosts = sortedByIndex.map((e) => e.cost_usd as number);

    expect(sortedCosts[0]).toBeCloseTo(0.1, 5);
    expect(sortedCosts[1]).toBeCloseTo(0.2, 5);
    expect(sortedCosts[2]).toBeCloseTo(0.3, 5);

    // Total summed cost across all events.
    const totalCost = costs.reduce((sum, c) => sum + c, 0);
    expect(totalCost).toBeCloseTo(0.6, 5);
  });

  it("zero-cost child produces cost_usd = 0 in the event", async () => {
    const items = [{ val: "no-cost" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
      // No cost events -- child produced no cost.
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    const iterEvents = await readIterCompleteEvents(parentId);
    expect(iterEvents).toHaveLength(1);
    expect(iterEvents[0].cost_usd).toBe(0);
  });
});

// ── Tests: average duration calculation ───────────────────────────────────────

describe("for_each observability -- avg duration from event payloads", () => {
  it("duration_ms is positive for 3 iterations with real async work", async () => {
    const items = [{ val: "a" }, { val: "b" }, { val: "c" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      // Simulate a small async delay to produce measurable duration.
      await Bun.sleep(5);
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    const iterEvents = await readIterCompleteEvents(parentId);
    expect(iterEvents).toHaveLength(3);

    const durations = iterEvents.map((e) => e.duration_ms as number);
    // Each duration must be a non-negative finite number.
    for (const d of durations) {
      expect(typeof d).toBe("number");
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
    }

    // Average duration calculation from the event payloads.
    const avgDurationMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
    expect(avgDurationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── Tests: inline mode enriched event ────────────────────────────────────────

describe("for_each observability -- inline mode -- enriched iteration_complete event", () => {
  it("emits for_each_iteration_complete with index, exit_status, duration_ms, cost_usd", async () => {
    const items = [{ val: "file-a" }, { val: "file-b" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeInlineDispatcher(async ({ sessionId }) => {
      // Inject cost on the parent session (inline mode -- all cost on parent).
      await injectCostEvent(sessionId, 0.05, "SessionEnd");
      return { ok: true, message: "ok" };
    });

    const result = await dispatcher.dispatchForEach(parentId, makeInlineStage(), vars);
    expect(result.ok).toBe(true);

    const iterEvents = await readIterCompleteEvents(parentId);
    expect(iterEvents).toHaveLength(2);

    for (const evt of iterEvents) {
      expect(typeof evt.index).toBe("number");
      expect(evt.exit_status).toBe("completed");
      expect(evt.mode).toBe("inline");
      expect(typeof evt.duration_ms).toBe("number");
      expect((evt.duration_ms as number) >= 0).toBe(true);
      expect(typeof evt.cost_usd).toBe("number");
      expect((evt.cost_usd as number) >= 0).toBe(true);
    }
  });

  it("inline mode cost_usd reflects delta from parent event log per iteration", async () => {
    const items = [{ val: "p" }, { val: "q" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    let iterationIdx = 0;
    const dispatcher = makeInlineDispatcher(async ({ sessionId }) => {
      // First iteration: $0.10, second iteration: $0.25.
      const cost = iterationIdx === 0 ? 0.1 : 0.25;
      iterationIdx++;
      await injectCostEvent(sessionId, cost, "SessionEnd");
      return { ok: true, message: "ok" };
    });

    const result = await dispatcher.dispatchForEach(parentId, makeInlineStage(), vars);
    expect(result.ok).toBe(true);

    const iterEvents = await readIterCompleteEvents(parentId);
    expect(iterEvents).toHaveLength(2);

    const sorted = iterEvents.sort((a, b) => (a.index as number) - (b.index as number));
    // First iteration cost should be close to 0.10.
    expect(sorted[0].cost_usd as number).toBeCloseTo(0.1, 5);
    // Second iteration cost should be close to 0.25.
    expect(sorted[1].cost_usd as number).toBeCloseTo(0.25, 5);
  });
});

// ── Tests: in-flight detection ────────────────────────────────────────────────

describe("for_each observability -- in-flight detection via checkpoint", () => {
  it("checkpoint.in_flight is set during child dispatch and cleared after completion", async () => {
    const items = [{ val: "a" }, { val: "b" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const inFlightDuringDispatch: Array<Record<string, unknown> | null> = [];

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      // Capture the checkpoint's in_flight during dispatch.
      const cp = await readCheckpoint(parentId);
      const inf = (cp?.in_flight as Record<string, unknown> | undefined) ?? null;
      inFlightDuringDispatch.push(inf);
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    // During dispatch, in_flight must be set for each iteration.
    expect(inFlightDuringDispatch).toHaveLength(2);
    for (const inf of inFlightDuringDispatch) {
      expect(inf).not.toBeNull();
      expect(typeof inf!.index).toBe("number");
      expect(typeof inf!.started_at).toBe("string");
    }

    // After completion, checkpoint is cleared (so in_flight is gone).
    const finalCp = await readCheckpoint(parentId);
    expect(finalCp == null).toBe(true);
  });

  it("pre-set in_flight checkpoint exposes child_session_id in in_flight pointer", async () => {
    // Simulate a mid-run checkpoint with an in_flight entry.
    const items = [{ val: "a" }, { val: "b" }, { val: "c" }];
    const { id: parentId } = await makeParentWithList(items);

    // Manually write an in_flight checkpoint (as if the daemon crashed mid-iteration).
    const fakeChildId = "s-fake-child-0001";
    await app.sessions.mergeConfig(parentId, {
      for_each_checkpoint: {
        stage_name: "per_item",
        total_items: 3,
        items,
        next_index: 2,
        in_flight: {
          index: 1,
          child_session_id: fakeChildId,
          started_at: new Date(Date.now() - 90_000).toISOString(), // 1.5 minutes ago
        },
      } as any,
    } as any);

    // Read it back and verify the in_flight is present.
    const cp = await readCheckpoint(parentId);
    expect(cp).not.toBeNull();
    const inf = cp!.in_flight as Record<string, unknown>;
    expect(inf).toBeDefined();
    expect(inf.index).toBe(1);
    expect(inf.child_session_id).toBe(fakeChildId);
    expect(typeof inf.started_at).toBe("string");

    // Verify elapsed time calculation would be ~90s.
    const startedMs = new Date(inf.started_at as string).getTime();
    const elapsed = Date.now() - startedMs;
    expect(elapsed).toBeGreaterThan(80_000); // at least 80s
  });
});

// ── Tests: event shape doesn't break existing test assertions ─────────────────

describe("for_each observability -- enriched event shape is backward-compatible", () => {
  it("for_each_iteration_complete event still has index and childId fields (spawn mode)", async () => {
    const items = [{ val: "compat" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
    });

    const result = await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);
    expect(result.ok).toBe(true);

    // The event must still have the existing fields that downstream code reads.
    const evts = await app.events.list(parentId, { type: "for_each_iteration_complete" });
    expect(evts).toHaveLength(1);
    const d = evts[0].data as Record<string, unknown>;
    // Legacy fields.
    expect(typeof d.index).toBe("number");
    expect(typeof d.childId).toBe("string");
    // New enriched fields.
    expect(d.exit_status).toBe("completed");
    expect(typeof d.duration_ms).toBe("number");
    expect(typeof d.cost_usd).toBe("number");
  });

  it("for_each_iteration_complete event in inline mode has index and mode fields", async () => {
    const items = [{ val: "compat-inline" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeInlineDispatcher();
    const result = await dispatcher.dispatchForEach(parentId, makeInlineStage(), vars);
    expect(result.ok).toBe(true);

    const evts = await app.events.list(parentId, { type: "for_each_iteration_complete" });
    expect(evts).toHaveLength(1);
    const d = evts[0].data as Record<string, unknown>;
    // Legacy fields.
    expect(typeof d.index).toBe("number");
    expect(d.mode).toBe("inline");
    // New enriched fields.
    expect(d.exit_status).toBe("completed");
    expect(typeof d.duration_ms).toBe("number");
    expect(typeof d.cost_usd).toBe("number");
  });
});

// ── Tests: rollup calculation helpers (unit-level) ────────────────────────────

describe("for_each observability -- rollup calculation from event payloads", () => {
  it("summing cost_usd across 3 synthetic events returns correct total", async () => {
    const items = [{ val: "1" }, { val: "2" }, { val: "3" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const costs = [0.18, 0.22, 0.1];
    let callNum = 0;

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
      await injectCostEvent(childId, costs[callNum], "SessionEnd");
      callNum++;
    });

    await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);

    const iterEvents = await readIterCompleteEvents(parentId);
    const totalCost = iterEvents.reduce((sum, e) => sum + ((e.cost_usd as number) ?? 0), 0);
    expect(totalCost).toBeCloseTo(0.5, 5);
  });

  it("average duration_ms calculation from 3 events produces finite result", async () => {
    const items = [{ val: "a" }, { val: "b" }, { val: "c" }];
    const { id: parentId, vars } = await makeParentWithList(items);

    const dispatcher = makeSpawnDispatcher(async (childId) => {
      await Bun.sleep(2);
      await app.sessions.update(childId, { status: "completed" });
    });

    await dispatcher.dispatchForEach(parentId, makeSpawnStage(), vars);

    const iterEvents = await readIterCompleteEvents(parentId);
    expect(iterEvents).toHaveLength(3);

    const durations = iterEvents.map((e) => e.duration_ms as number);
    const avgDurationMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;

    expect(Number.isFinite(avgDurationMs)).toBe(true);
    expect(avgDurationMs).toBeGreaterThanOrEqual(0);
  });
});
