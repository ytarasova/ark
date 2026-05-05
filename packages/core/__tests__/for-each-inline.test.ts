/**
 * Tests for the for_each + mode:inline primitive (P2.5).
 *
 * Strategy: instantiate ForEachDispatcher directly with a mocked
 * dispatchInlineSubStage callback. This isolates the iteration logic,
 * template substitution, and failure-policy handling without launching
 * real agents or touching dispatch-core.ts.
 *
 * AppContext is used for real DB/session/event operations.
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

/** Captured dispatch call from the mock. */
interface CapturedCall {
  sessionId: string;
  subStage: StageDefinition;
  iterVars: Record<string, string>;
}

/**
 * Build a ForEachDispatcher wired for inline mode.
 *
 * `onSubStage` is called for each sub-stage dispatch. It returns the result
 * for that sub-stage. Default: returns ok:true.
 */
function makeInlineDispatcher(onSubStage?: (call: CapturedCall) => Promise<{ ok: boolean; message: string }>): {
  dispatcher: ForEachDispatcher;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];

  const dispatchInlineSubStage: DispatchInlineSubStageCb = async (sessionId, subStage, iterVars) => {
    const call: CapturedCall = { sessionId, subStage, iterVars };
    calls.push(call);
    if (onSubStage) return onSubStage(call);
    return { ok: true, message: "mocked sub-stage ok" };
  };

  const dispatcher = new ForEachDispatcher({
    sessions: app.sessions,
    events: app.events,
    flows: app.flows,
    dispatchChild: async () => ({ ok: true, message: "unused in inline mode" }),
    dispatchInlineSubStage,
  });

  return { dispatcher, calls };
}

/**
 * Create a parent session with an embedded list in its config inputs.
 */
async function makeParentWithList(list: unknown[]): Promise<{ id: string; vars: Record<string, string> }> {
  const session = await app.sessions.create({
    summary: "test parent",
    flow: "bare",
    config: { inputs: { files: JSON.stringify(list) } },
  });
  await app.sessions.update(session.id, { stage: "per_file", status: "ready" });
  const updated = (await app.sessions.get(session.id))!;
  const vars = buildSessionVars(updated as unknown as Record<string, unknown>);
  return { id: session.id, vars };
}

/** Minimal inline for_each stage definition. */
function makeInlineStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: "per_file",
    for_each: "{{inputs.files}}",
    mode: "inline",
    iteration_var: "file",
    on_iteration_failure: "stop",
    gate: "auto",
    stages: [
      {
        name: "write_tests",
        gate: "auto",
        agent: {
          runtime: "claude-agent",
          system_prompt: "Write tests for {{file.path}}",
        },
        task: "Write tests for {{file.path}} per: {{file.criteria}}",
      },
      {
        name: "implement",
        gate: "auto",
        agent: {
          runtime: "claude-agent",
          system_prompt: "Implement the changes",
        },
        task: "Implement {{file.prompt}}",
      },
    ],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("for_each + mode:inline -- basic loop", () => {
  it("dispatches all sub-stages for each iteration (2 items x 2 sub-stages = 4 calls)", async () => {
    const items = [
      { path: "/src/a.ts", criteria: "unit", prompt: "implement a" },
      { path: "/src/b.ts", criteria: "integration", prompt: "implement b" },
    ];

    const { dispatcher, calls } = makeInlineDispatcher();
    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeInlineStage();

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    // 2 iterations x 2 sub-stages = 4 total calls
    expect(calls).toHaveLength(4);

    // First two calls belong to item 0
    expect(calls[0].subStage.name).toBe("write_tests");
    expect(calls[1].subStage.name).toBe("implement");
    // Second two calls belong to item 1
    expect(calls[2].subStage.name).toBe("write_tests");
    expect(calls[3].subStage.name).toBe("implement");
  });
});

describe("for_each + mode:inline -- iteration variable substitution in task", () => {
  it("substitutes {{file.path}} in sub-stage task per iteration", async () => {
    const items = [
      { path: "/src/foo.ts", criteria: "unit", prompt: "impl foo" },
      { path: "/src/bar.ts", criteria: "e2e", prompt: "impl bar" },
    ];

    const { dispatcher, calls } = makeInlineDispatcher();
    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeInlineStage();

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(result.ok).toBe(true);

    // write_tests for item 0: task should have path /src/foo.ts
    const writeTestsItem0 = calls[0];
    expect(writeTestsItem0.subStage.task).toContain("/src/foo.ts");
    expect(writeTestsItem0.subStage.task).toContain("unit");

    // implement for item 0: task should have impl foo
    const implementItem0 = calls[1];
    expect(implementItem0.subStage.task).toContain("impl foo");

    // write_tests for item 1: task should have path /src/bar.ts
    const writeTestsItem1 = calls[2];
    expect(writeTestsItem1.subStage.task).toContain("/src/bar.ts");
    expect(writeTestsItem1.subStage.task).toContain("e2e");
  });
});

describe("for_each + mode:inline -- iteration variable substitution in agent system_prompt", () => {
  it("substitutes {{file.path}} in inline agent system_prompt per iteration", async () => {
    const items = [
      { path: "/src/alpha.ts", criteria: "unit", prompt: "impl alpha" },
      { path: "/src/beta.ts", criteria: "perf", prompt: "impl beta" },
    ];

    const { dispatcher, calls } = makeInlineDispatcher();
    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeInlineStage();

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(result.ok).toBe(true);

    // write_tests sub-stage agent system_prompt should have item's path
    const call0 = calls[0]; // write_tests for /src/alpha.ts
    const agentSpec0 = call0.subStage.agent as { system_prompt: string };
    expect(agentSpec0.system_prompt).toContain("/src/alpha.ts");

    const call2 = calls[2]; // write_tests for /src/beta.ts
    const agentSpec2 = call2.subStage.agent as { system_prompt: string };
    expect(agentSpec2.system_prompt).toContain("/src/beta.ts");
  });
});

describe("for_each + mode:inline -- sequential order", () => {
  it("iteration 1's sub-stages all complete before iteration 2 begins", async () => {
    const items = [{ path: "/src/x.ts" }, { path: "/src/y.ts" }, { path: "/src/z.ts" }];
    const order: string[] = [];

    const { dispatcher } = makeInlineDispatcher(async (call) => {
      order.push(`${call.subStage.name}:${call.iterVars["file.path"]}`);
      return { ok: true, message: "ok" };
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeInlineStage();

    await dispatcher.dispatchForEach(parentId, stage, vars);

    // Expected order: write_tests:/src/x.ts, implement:/src/x.ts, write_tests:/src/y.ts, implement:/src/y.ts, ...
    expect(order[0]).toBe("write_tests:/src/x.ts");
    expect(order[1]).toBe("implement:/src/x.ts");
    expect(order[2]).toBe("write_tests:/src/y.ts");
    expect(order[3]).toBe("implement:/src/y.ts");
    expect(order[4]).toBe("write_tests:/src/z.ts");
    expect(order[5]).toBe("implement:/src/z.ts");
  });
});

describe("for_each + mode:inline -- parent worktree is shared", () => {
  it("all sub-stages run against the parent session id (no child session created)", async () => {
    const items = [{ path: "/src/shared.ts" }];
    const capturedSessionIds: string[] = [];

    const { dispatcher } = makeInlineDispatcher(async (call) => {
      capturedSessionIds.push(call.sessionId);
      return { ok: true, message: "ok" };
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeInlineStage();

    await dispatcher.dispatchForEach(parentId, stage, vars);

    // All calls must use the parent's session ID -- no children created
    for (const sid of capturedSessionIds) {
      expect(sid).toBe(parentId);
    }

    // No child sessions should have been created
    const children = await app.sessions.getChildren(parentId);
    expect(children).toHaveLength(0);
  });
});

describe("for_each + mode:inline -- on_iteration_failure: stop", () => {
  it("stops after sub-stage fails in iteration 2 -- iteration 3 is NOT run", async () => {
    const items = [{ path: "/src/a.ts" }, { path: "/src/b.ts" }, { path: "/src/c.ts" }];
    const calledPaths: string[] = [];

    const { dispatcher } = makeInlineDispatcher(async (call) => {
      calledPaths.push(call.iterVars["file.path"] ?? "");
      // Fail the first sub-stage of item 1 (/src/b.ts)
      if (call.iterVars["file.path"] === "/src/b.ts" && call.subStage.name === "write_tests") {
        return { ok: false, message: "sub-stage failed" };
      }
      return { ok: true, message: "ok" };
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeInlineStage({ on_iteration_failure: "stop" });

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("failed");

    // /src/c.ts should never be dispatched
    expect(calledPaths).not.toContain("/src/c.ts");
    // /src/b.ts write_tests was called (and failed); /src/b.ts implement should NOT be called
    const bCalls = calledPaths.filter((p) => p === "/src/b.ts");
    // Only 1 sub-stage of b was dispatched (write_tests failed, implement skipped)
    expect(bCalls).toHaveLength(1);
  });
});

describe("for_each + mode:inline -- on_iteration_failure: continue", () => {
  it("continues to iteration 3 after iteration 2 fails", async () => {
    const items = [{ path: "/src/a.ts" }, { path: "/src/b.ts" }, { path: "/src/c.ts" }];
    const calledPaths = new Set<string>();

    const { dispatcher } = makeInlineDispatcher(async (call) => {
      calledPaths.add(call.iterVars["file.path"] ?? "");
      if (call.iterVars["file.path"] === "/src/b.ts" && call.subStage.name === "write_tests") {
        return { ok: false, message: "sub-stage failed" };
      }
      return { ok: true, message: "ok" };
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeInlineStage({ on_iteration_failure: "continue" });

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    // continue means the loop kept dispatching after the failure, but the
    // parent's overall outcome is a failure since iteration 2 failed.
    expect(result.ok).toBe(false);
    // /src/c.ts should still have been dispatched
    expect(calledPaths.has("/src/c.ts")).toBe(true);
    // Summary reflects the partial-failure shape
    expect(result.message).toContain("1 of 3 iterations failed");
    expect(result.message).toContain("2 succeeded");
  });
});

describe("for_each + mode:inline -- empty list", () => {
  it("completes immediately with no sub-stage dispatches", async () => {
    const { dispatcher, calls } = makeInlineDispatcher();
    const { id: parentId, vars } = await makeParentWithList([]);
    const stage = makeInlineStage();

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("empty list");
    expect(calls).toHaveLength(0);
  });
});

describe("for_each + mode:inline -- missing dispatchInlineSubStage callback", () => {
  it("returns an error when callback is not wired", async () => {
    // Create dispatcher WITHOUT dispatchInlineSubStage
    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      dispatchChild: async () => ({ ok: true, message: "unused" }),
      // dispatchInlineSubStage intentionally omitted
    });

    const items = [{ path: "/src/x.ts" }];
    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeInlineStage();

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("dispatchInlineSubStage");
  });
});
