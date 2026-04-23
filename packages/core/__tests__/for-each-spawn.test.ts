/**
 * Tests for the for_each + mode:spawn primitive (P2.0a).
 *
 * Strategy: instantiate ForEachDispatcher directly with a mocked dispatchChild
 * that immediately sets the child session to "completed". This isolates the
 * iteration + template-substitution logic without launching real agents.
 *
 * AppContext is used for real DB/session/event operations so the integration
 * path (session create, update, get) is exercised.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { ForEachDispatcher } from "../services/dispatch/dispatch-foreach.js";
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

/**
 * Build a ForEachDispatcher with a custom dispatchChild mock.
 *
 * `onDispatch` is called every time a child is dispatched. It receives the
 * childId and may perform side effects (e.g. mark the child completed).
 * By default it immediately marks the child as "completed".
 */
function makeDispatcher(onDispatch?: (childId: string) => Promise<void>): ForEachDispatcher {
  const dispatchChild: DispatchDeps["dispatchChild"] = async (childId: string) => {
    if (onDispatch) {
      await onDispatch(childId);
    } else {
      // Default: mark child completed immediately so waitForChild resolves.
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

/**
 * Create a parent session with an embedded list in its config inputs.
 * The list is stored as `config.inputs.myList` so the template `{{myList}}`
 * resolves via buildSessionVars -> inputs.myList.
 */
async function makeParentWithList(list: unknown[]): Promise<{ id: string; vars: Record<string, string> }> {
  const session = await app.sessions.create({
    summary: "test parent",
    flow: "bare",
    config: { inputs: { repos: JSON.stringify(list) } },
  });
  await app.sessions.update(session.id, { stage: "per_repo", status: "ready" });
  const updated = (await app.sessions.get(session.id))!;
  const vars = buildSessionVars(updated as unknown as Record<string, unknown>);
  return { id: session.id, vars };
}

/** Minimal for_each stage definition. */
function makeStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: "per_repo",
    for_each: "{{inputs.repos}}",
    mode: "spawn",
    iteration_var: "repo",
    on_iteration_failure: "stop",
    gate: "auto",
    spawn: {
      flow: "bare",
      inputs: {
        repo_path: "{{repo.path}}",
        branch: "{{repo.branch}}",
      },
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("for_each + mode:spawn -- iterates list and spawns children", () => {
  it("spawns one child session per item for a 3-item list", async () => {
    const items = [
      { path: "/repo/a", branch: "main" },
      { path: "/repo/b", branch: "dev" },
      { path: "/repo/c", branch: "feat" },
    ];

    const dispatchedIds: string[] = [];
    const dispatcher = makeDispatcher(async (childId) => {
      dispatchedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStage();

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(dispatchedIds).toHaveLength(3);

    // Verify all children are linked to the parent
    const children = await app.sessions.getChildren(parentId);
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.parent_id).toBe(parentId);
      expect(child.flow).toBe("bare");
    }
  });

  it("empty list completes stage immediately without spawning any children", async () => {
    const dispatchedIds: string[] = [];
    const dispatcher = makeDispatcher(async (childId) => {
      dispatchedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList([]);
    const stage = makeStage();

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(result.message).toContain("empty list");
    expect(dispatchedIds).toHaveLength(0);
  });
});

describe("for_each + mode:spawn -- sequential execution", () => {
  it("awaits each child before starting the next one", async () => {
    const items = [{ x: 1 }, { x: 2 }, { x: 3 }];
    const order: string[] = [];

    const dispatcher = makeDispatcher(async (childId) => {
      order.push(`start:${childId}`);
      // Simulate a tiny async gap
      await app.sessions.update(childId, { status: "completed" });
      order.push(`done:${childId}`);
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStage({
      spawn: { flow: "bare", inputs: { idx: "{{item.x}}" } },
    });

    await dispatcher.dispatchForEach(parentId, stage, vars);

    // Each child should be fully done before the next starts
    // Order: start0, done0, start1, done1, start2, done2
    for (let i = 0; i < items.length - 1; i++) {
      const doneIdx = order.indexOf(`done:${order[i * 2].slice(6)}`);
      const startNextIdx = order.indexOf(`start:${order[(i + 1) * 2].slice(6)}`);
      expect(doneIdx).toBeLessThan(startNextIdx);
    }
  });
});

describe("for_each + mode:spawn -- iteration variable substitution", () => {
  it("substitutes iteration_var fields into spawn inputs", async () => {
    const items = [
      { repo_path: "/home/user/alpha", branch: "main" },
      { repo_path: "/home/user/beta", branch: "release" },
    ];

    const createdSummaries: string[] = [];
    const dispatcher = makeDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
    });

    // Track what sessions were created by inspecting them after the run
    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStage({
      iteration_var: "repo",
      spawn: {
        flow: "bare",
        inputs: {
          summary: "{{repo.repo_path}} on {{repo.branch}}",
          path: "{{repo.repo_path}}",
        },
      },
    });

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(result.ok).toBe(true);

    const children = await app.sessions.getChildren(parentId);
    expect(children).toHaveLength(2);

    // Verify inputs were substituted correctly by checking child configs
    const child0 = children.find((c) => (c.config as any)?.inputs?.path === "/home/user/alpha");
    const child1 = children.find((c) => (c.config as any)?.inputs?.path === "/home/user/beta");
    expect(child0).toBeDefined();
    expect(child1).toBeDefined();
    expect((child0!.config as any)?.inputs?.path).toBe("/home/user/alpha");
    expect((child1!.config as any)?.inputs?.path).toBe("/home/user/beta");
  });

  it("default iteration_var is 'item' when omitted", async () => {
    const items = [{ x: "value-a" }, { x: "value-b" }];

    const dispatcher = makeDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    // No iteration_var field -- should default to "item"
    const stage = makeStage({
      iteration_var: undefined,
      spawn: {
        flow: "bare",
        inputs: {
          extracted: "{{item.x}}",
        },
      },
    });
    delete (stage as any).iteration_var;

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(result.ok).toBe(true);

    const children = await app.sessions.getChildren(parentId);
    expect(children).toHaveLength(2);

    const values = children.map((c) => (c.config as any)?.inputs?.extracted).sort();
    expect(values).toEqual(["value-a", "value-b"]);
  });
});

describe("for_each + mode:spawn -- on_iteration_failure: stop", () => {
  it("stops after item 2 fails and does not spawn further items", async () => {
    const items = [{ idx: 0 }, { idx: 1 }, { idx: 2 }, { idx: 3 }];
    const dispatchCount: number[] = [];
    let callNum = 0;

    const dispatcher = makeDispatcher(async (childId) => {
      const n = callNum++;
      dispatchCount.push(n);
      if (n === 1) {
        // Item at index 1 (second child) fails
        await app.sessions.update(childId, { status: "failed" });
      } else {
        await app.sessions.update(childId, { status: "completed" });
      }
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStage({ on_iteration_failure: "stop" });

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("failed");
    // Only 2 children dispatched (index 0 and 1); items 2 and 3 never started
    expect(dispatchCount).toHaveLength(2);
  });
});

describe("for_each + mode:spawn -- on_iteration_failure: continue", () => {
  it("continues after item 2 fails and spawns all remaining items", async () => {
    const items = [{ idx: 0 }, { idx: 1 }, { idx: 2 }, { idx: 3 }];
    const dispatchCount: number[] = [];
    let callNum = 0;

    const dispatcher = makeDispatcher(async (childId) => {
      const n = callNum++;
      dispatchCount.push(n);
      if (n === 1) {
        // Item at index 1 (second child) fails
        await app.sessions.update(childId, { status: "failed" });
      } else {
        await app.sessions.update(childId, { status: "completed" });
      }
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStage({ on_iteration_failure: "continue" });

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    // All 4 children dispatched despite item 1 failing
    expect(dispatchCount).toHaveLength(4);
    expect(result.message).toContain("3 succeeded");
    expect(result.message).toContain("1 failed");
  });
});
