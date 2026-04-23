/**
 * Tests for for_each budget caps (P3.1).
 *
 * Two budget cap types:
 *   1. Per-session cumulative cap (session.config.max_budget_usd):
 *      checked at each iteration boundary; halts the loop with
 *      for_each_budget_exceeded event + session status "failed".
 *   2. Per-iteration (agent-level) max_budget_usd on InlineAgentSpec /
 *      StageDefinition.max_budget_usd: propagated to sub-stage agent
 *      or to child session config.
 *
 * Strategy: instantiate ForEachDispatcher directly with mocked
 * sessions/events/flows/dispatchChild/dispatchInlineSubStage. Budget
 * enforcement is unit-tested by injecting synthetic hook_status events
 * that carry cost_usd values.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { ForEachDispatcher } from "../services/dispatch/dispatch-foreach.js";
import type { DispatchInlineSubStageCb } from "../services/dispatch/dispatch-foreach.js";
import type { StageDefinition } from "../state/flow.js";
import { buildSessionVars } from "../template.js";

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

/** Create a parent session. max_budget_usd is written to config when provided. */
async function makeParent(
  list: unknown[],
  opts: { maxBudget?: number } = {},
): Promise<{ id: string; vars: Record<string, string> }> {
  const session = await app.sessions.create({
    summary: "budget test parent",
    flow: "bare",
    config: {
      inputs: { repos: JSON.stringify(list) },
      ...(opts.maxBudget !== undefined ? { max_budget_usd: opts.maxBudget } : {}),
    },
  });
  await app.sessions.update(session.id, { stage: "per_repo", status: "ready" });
  const updated = (await app.sessions.get(session.id))!;
  const vars = buildSessionVars(updated as unknown as Record<string, unknown>);
  return { id: session.id, vars };
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

/** Minimal spawn-mode stage. */
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

/** Minimal inline-mode stage. */
function makeInlineStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: "per_repo",
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
          runtime: "agent-sdk",
          system_prompt: "Do work on {{repo.path}}",
        },
        task: "Work on {{repo.path}}",
      },
    ],
    ...overrides,
  };
}

/** Build a dispatcher for spawn-mode tests. */
function makeSpawnDispatcher(onDispatch?: (childId: string) => Promise<void>): ForEachDispatcher {
  return new ForEachDispatcher({
    sessions: app.sessions,
    events: app.events,
    flows: app.flows,
    dispatchChild: async (childId) => {
      if (onDispatch) await onDispatch(childId);
      else await app.sessions.update(childId, { status: "completed" });
      return { ok: true, message: "mocked dispatch" };
    },
  });
}

/** Build a dispatcher for inline-mode tests. */
function makeInlineDispatcher(
  onSubStage?: (call: { sessionId: string; subStage: StageDefinition; iterVars: Record<string, string> }) => Promise<{
    ok: boolean;
    message: string;
  }>,
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

// ── sumPriorIterationCosts unit-level tests ───────────────────────────────────

describe("sumPriorIterationCosts -- via budget enforcement (indirect)", () => {
  it("correctly sums SessionEnd cost events before halting", async () => {
    // 3 items, cap = 5.0, each child costs 2.0 -> halt before iteration 3
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParent(items, { maxBudget: 5.0 });

    const dispatchedIds: string[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      dispatchedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
      // Inject a cost event on the parent session for each completed child
      // (simulating the hook pipeline writing to the parent's event log)
      await injectCostEvent(parentId, 2.0, "SessionEnd");
    });

    const stage = makeSpawnStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    // Should halt: after iteration 1 cumulative = 2.0, after iteration 2 = 4.0
    // Before iteration 3 cumulative = 4.0 < 5.0, so iteration 3 runs.
    // Before iteration 4 (which doesn't exist) 6.0 >= 5.0, but no iteration 4.
    // With exactly 3 items and cap 5.0: after 2 children cost=4.0 < 5.0 so
    // iteration 2 starts. After 2 children complete cost=4.0; iteration 3 costs
    // 2.0 so total=6.0 but the check happens BEFORE spawning, so iteration 3
    // starts (4.0 < 5.0) but iteration 4 would halt -- there is no iteration 4.
    // All 3 should complete since the cap check is BEFORE each iteration.
    expect(result.ok).toBe(true);
    expect(dispatchedIds).toHaveLength(3);
  });

  it("halts before iteration 3 when cumulative cost exceeds cap", async () => {
    // 4 items, cap = 5.0, each child costs 2.0 -> halt before iteration 3
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }, { path: "/d" }];
    const { id: parentId, vars } = await makeParent(items, { maxBudget: 5.0 });

    const dispatchedIds: string[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      dispatchedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
      // Each child completion adds 2.0 to the parent's cumulative cost
      await injectCostEvent(parentId, 2.0, "SessionEnd");
    });

    const stage = makeSpawnStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    // Before iter 0: cost = 0 < 5.0 -> OK
    // Before iter 1: cost = 2.0 < 5.0 -> OK
    // Before iter 2: cost = 4.0 < 5.0 -> OK
    // Before iter 3: cost = 6.0 >= 5.0 -> HALT (but items[3] = "/d" is the 4th)
    // Wait: 3 dispatched means iter 0,1,2 ran; iter 3 is halted.
    expect(result.ok).toBe(false);
    expect(result.message).toContain("budget exceeded");
    expect(dispatchedIds).toHaveLength(3);

    // Verify the budget_exceeded event was logged
    const events = await app.events.list(parentId, { type: "for_each_budget_exceeded" });
    expect(events).toHaveLength(1);
    const evtData = events[0].data as Record<string, unknown>;
    expect(evtData.cap_usd).toBe(5.0);
    expect(evtData.next_iteration).toBe(3);

    // Verify session was marked failed
    const updated = await app.sessions.get(parentId);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("budget exceeded");
  });

  it("also counts StopFailure events toward cumulative cost", async () => {
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParent(items, { maxBudget: 3.0 });

    const dispatchedIds: string[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      dispatchedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
      // StopFailure also contributes to cost
      await injectCostEvent(parentId, 2.0, "StopFailure");
    });

    const stage = makeSpawnStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    // Before iter 0: 0 < 3.0 -> OK
    // Before iter 1: 2.0 < 3.0 -> OK
    // Before iter 2: 4.0 >= 3.0 -> HALT
    expect(result.ok).toBe(false);
    expect(result.message).toContain("budget exceeded");
    expect(dispatchedIds).toHaveLength(2);
  });
});

// ── No cap set: all iterations run regardless of cost ────────────────────────

describe("budget cap -- no cap set", () => {
  it("spawn mode: all iterations run when no cap is set", async () => {
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParent(items); // no maxBudget

    const dispatchedIds: string[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      dispatchedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
      // Even with high costs, no cap means no halt
      await injectCostEvent(parentId, 100.0, "SessionEnd");
    });

    const stage = makeSpawnStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(dispatchedIds).toHaveLength(3);
  });

  it("inline mode: all iterations run when no cap is set", async () => {
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParent(items);

    const calls: string[] = [];
    const dispatcher = makeInlineDispatcher(async (call) => {
      calls.push(call.iterVars["repo.path"] ?? "");
      // Inject big costs -- should have no effect without a cap
      await injectCostEvent(parentId, 100.0, "SessionEnd");
      return { ok: true, message: "ok" };
    });

    const stage = makeInlineStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });
});

// ── Cap = 0: halts immediately ────────────────────────────────────────────────

describe("budget cap = 0", () => {
  it("spawn mode: halts before iteration 0 when cap is 0", async () => {
    const items = [{ path: "/a" }, { path: "/b" }];
    const { id: parentId, vars } = await makeParent(items, { maxBudget: 0 });

    // Pre-seed a tiny cost so 0 >= 0 triggers
    await injectCostEvent(parentId, 0.001, "SessionEnd");

    const dispatchedIds: string[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      dispatchedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
    });

    const stage = makeSpawnStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("budget exceeded");
    expect(dispatchedIds).toHaveLength(0);
  });

  it("spawn mode: zero cost with cap=0 halts because 0 >= 0", async () => {
    const items = [{ path: "/a" }];
    const { id: parentId, vars } = await makeParent(items, { maxBudget: 0 });

    // No events: cumulative = 0.0, cap = 0 -> 0 >= 0 -> halt
    const dispatchedIds: string[] = [];
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      dispatchedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
    });

    const stage = makeSpawnStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("budget exceeded");
    expect(dispatchedIds).toHaveLength(0);
  });
});

// ── Inline mode cumulative budget ─────────────────────────────────────────────

describe("budget cap -- inline mode cumulative", () => {
  it("halts inline before iteration 2 when cumulative cost >= cap", async () => {
    const items = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
    const { id: parentId, vars } = await makeParent(items, { maxBudget: 3.5 });

    const calledPaths: string[] = [];
    const dispatcher = makeInlineDispatcher(async (call) => {
      const path = call.iterVars["repo.path"] ?? "";
      calledPaths.push(path);
      // Inject cost after each sub-stage completes (in parent's event log)
      await injectCostEvent(parentId, 2.0, "SessionEnd");
      return { ok: true, message: "ok" };
    });

    const stage = makeInlineStage();
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    // Before iter 0: 0 < 3.5 -> OK, do_work runs, adds 2.0
    // Before iter 1: 2.0 < 3.5 -> OK, do_work runs, adds 2.0 (total 4.0)
    // Before iter 2: 4.0 >= 3.5 -> HALT
    expect(result.ok).toBe(false);
    expect(result.message).toContain("budget exceeded");
    expect(calledPaths).not.toContain("/c");
    expect(calledPaths.filter((p) => p === "/a")).toHaveLength(1);
    expect(calledPaths.filter((p) => p === "/b")).toHaveLength(1);
  });
});

// ── Stage-level max_budget_usd propagation ────────────────────────────────────

describe("stage-level max_budget_usd propagates to inline sub-stage agent", () => {
  it("propagates stage max_budget_usd to inline agent spec when agent has no own budget", async () => {
    const items = [{ path: "/a" }];
    const { id: parentId, vars } = await makeParent(items);

    const capturedAgents: Array<{ max_budget_usd?: number }> = [];
    const dispatcher = makeInlineDispatcher(async (call) => {
      const agent = call.subStage.agent as { max_budget_usd?: number } | undefined;
      if (agent) capturedAgents.push({ max_budget_usd: agent.max_budget_usd });
      return { ok: true, message: "ok" };
    });

    const stage = makeInlineStage({ max_budget_usd: 2.5 });
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(capturedAgents).toHaveLength(1);
    // The stage-level budget was propagated to the resolved sub-stage agent
    expect(capturedAgents[0].max_budget_usd).toBe(2.5);
  });

  it("does NOT override agent's own max_budget_usd when already set", async () => {
    const items = [{ path: "/a" }];
    const { id: parentId, vars } = await makeParent(items);

    const capturedAgents: Array<{ max_budget_usd?: number }> = [];
    const dispatcher = makeInlineDispatcher(async (call) => {
      const agent = call.subStage.agent as { max_budget_usd?: number } | undefined;
      if (agent) capturedAgents.push({ max_budget_usd: agent.max_budget_usd });
      return { ok: true, message: "ok" };
    });

    // Stage budget = 5.0 but agent already declares 1.0 -- agent's own wins
    const stage: StageDefinition = {
      ...makeInlineStage({ max_budget_usd: 5.0 }),
      stages: [
        {
          name: "do_work",
          gate: "auto",
          agent: {
            runtime: "agent-sdk",
            system_prompt: "Work",
            max_budget_usd: 1.0,
          },
          task: "Work",
        },
      ],
    };

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(capturedAgents[0].max_budget_usd).toBe(1.0); // Agent's own value preserved
  });
});

// ── Spawn mode: stage-level iterBudget propagated to child config ─────────────

describe("stage-level max_budget_usd propagated to spawned child config", () => {
  it("child session config.max_budget_usd is set from stage max_budget_usd", async () => {
    const items = [{ path: "/a" }];
    const { id: parentId, vars } = await makeParent(items);

    let spawnedChildId: string | undefined;
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      spawnedChildId = childId;
      await app.sessions.update(childId, { status: "completed" });
    });

    const stage = makeSpawnStage({ max_budget_usd: 7.5 });
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(spawnedChildId).toBeDefined();
    const child = await app.sessions.get(spawnedChildId!);
    expect((child?.config as Record<string, unknown>)?.max_budget_usd).toBe(7.5);
  });

  it("child session config.max_budget_usd is absent when stage has no budget", async () => {
    const items = [{ path: "/a" }];
    const { id: parentId, vars } = await makeParent(items);

    let spawnedChildId: string | undefined;
    const dispatcher = makeSpawnDispatcher(async (childId) => {
      spawnedChildId = childId;
      await app.sessions.update(childId, { status: "completed" });
    });

    const stage = makeSpawnStage(); // no max_budget_usd
    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    const child = await app.sessions.get(spawnedChildId!);
    expect((child?.config as Record<string, unknown>)?.max_budget_usd).toBeUndefined();
  });
});

// ── CreateSessionOpts.max_budget_usd stored in config ────────────────────────

describe("CreateSessionOpts.max_budget_usd stored in session config", () => {
  it("session.config.max_budget_usd is set when provided at create", async () => {
    const session = await app.sessions.create({
      summary: "budget cap test",
      flow: "bare",
      max_budget_usd: 12.5,
    });

    const loaded = await app.sessions.get(session.id);
    expect((loaded?.config as Record<string, unknown>)?.max_budget_usd).toBe(12.5);
  });

  it("session.config.max_budget_usd is absent when not provided", async () => {
    const session = await app.sessions.create({
      summary: "no budget",
      flow: "bare",
    });

    const loaded = await app.sessions.get(session.id);
    expect((loaded?.config as Record<string, unknown>)?.max_budget_usd).toBeUndefined();
  });

  it("max_budget_usd is preserved alongside other config fields", async () => {
    const session = await app.sessions.create({
      summary: "with config",
      flow: "bare",
      max_budget_usd: 3.0,
      config: { turns: 12 },
    });

    const loaded = await app.sessions.get(session.id);
    const cfg = loaded?.config as Record<string, unknown>;
    expect(cfg?.max_budget_usd).toBe(3.0);
    expect(cfg?.turns).toBe(12);
  });
});
