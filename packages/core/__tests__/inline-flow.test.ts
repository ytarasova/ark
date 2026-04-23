/**
 * Tests for inline flow definitions in spawn.flow (P2.4).
 *
 * An inline flow is an object passed directly as `spawn.flow` in a for_each
 * stage, rather than a string name that is looked up in the flow store.
 * The ForEachDispatcher registers the definition in the EphemeralFlowStore
 * under "inline-{childId}" and persists it on the child session's
 * config.inline_flow field for daemon-restart rehydration.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { setApp, clearApp } from "./test-helpers.js";
import { ForEachDispatcher } from "../services/dispatch/dispatch-foreach.js";
import type { StageDefinition, InlineFlowSpec } from "../state/flow.js";
import { buildSessionVars } from "../template.js";
import type { DispatchDeps } from "../services/dispatch/types.js";

// ── Test context ─────────────────────────────────────────────────────────────

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
}, 30_000);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDispatcher(onDispatch?: (childId: string) => Promise<void>): ForEachDispatcher {
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

async function makeParentWithList(list: unknown[]): Promise<{ id: string; vars: Record<string, string> }> {
  const session = await app.sessions.create({
    summary: "inline-flow test parent",
    flow: "bare",
    config: { inputs: { items: JSON.stringify(list) } },
  });
  await app.sessions.update(session.id, { stage: "per_item", status: "ready" });
  const updated = (await app.sessions.get(session.id))!;
  const vars = buildSessionVars(updated as unknown as Record<string, unknown>);
  return { id: session.id, vars };
}

/** Minimal inline flow spec with one stage. */
function makeInlineFlowSpec(name?: string): InlineFlowSpec {
  return {
    ...(name ? { name } : {}),
    description: "inline test flow",
    stages: [
      {
        name: "do-work",
        gate: "auto",
        agent: "implementer",
        task: "Do the work.",
      },
    ],
  };
}

/** Minimal for_each stage that uses an inline flow. */
function makeStageWithInlineFlow(
  inlineFlow: InlineFlowSpec,
  overrides: Partial<StageDefinition> = {},
): StageDefinition {
  return {
    name: "per_item",
    for_each: "{{inputs.items}}",
    mode: "spawn",
    iteration_var: "item",
    on_iteration_failure: "stop",
    gate: "auto",
    spawn: {
      flow: inlineFlow,
      inputs: {
        value: "{{item}}",
      },
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("inline flow -- spawn.flow as object", () => {
  it("spawns one child session per item using an inline flow", async () => {
    const items = ["a", "b", "c"];
    const dispatched: string[] = [];

    const dispatcher = makeDispatcher(async (childId) => {
      dispatched.push(childId);
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStageWithInlineFlow(makeInlineFlowSpec("tdd-cycle"));

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(dispatched).toHaveLength(3);

    // All children must be linked to the parent
    const children = await app.sessions.getChildren(parentId);
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child.parent_id).toBe(parentId);
    }
  });

  it("child session.flow is set to 'inline-{childId}' for inline flow", async () => {
    const items = ["x"];
    const dispatcher = makeDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStageWithInlineFlow(makeInlineFlowSpec());

    await dispatcher.dispatchForEach(parentId, stage, vars);

    const children = await app.sessions.getChildren(parentId);
    expect(children).toHaveLength(1);

    const child = children[0];
    // Flow name should be "inline-{childId}"
    expect(child.flow).toBe(`inline-${child.id}`);
  });

  it("persists inline definition on child config.inline_flow for restart rehydration", async () => {
    const items = ["z"];
    const dispatcher = makeDispatcher(async (childId) => {
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const spec = makeInlineFlowSpec("my-flow");
    const stage = makeStageWithInlineFlow(spec);

    await dispatcher.dispatchForEach(parentId, stage, vars);

    const children = await app.sessions.getChildren(parentId);
    expect(children).toHaveLength(1);

    const child = children[0];
    const inlineFlow = (child.config as Record<string, unknown>)?.inline_flow;
    expect(inlineFlow).toBeDefined();

    const def = inlineFlow as Record<string, unknown>;
    expect(def.name).toBe(`inline-${child.id}`);
    expect(Array.isArray(def.stages)).toBe(true);
    expect((def.stages as unknown[]).length).toBe(1);
  });

  it("inline flow definition is retrievable via app.flows.get after spawn", async () => {
    const items = ["q"];
    let spawnedChildId: string | null = null;

    const dispatcher = makeDispatcher(async (childId) => {
      spawnedChildId = childId;
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStageWithInlineFlow(makeInlineFlowSpec("lookup-test"));

    await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(spawnedChildId).not.toBeNull();

    const syntheticName = `inline-${spawnedChildId}`;
    const def = app.flows.get(syntheticName);
    expect(def).not.toBeNull();
    expect(def!.name).toBe(syntheticName);
    expect(def!.stages[0].name).toBe("do-work");
  });

  it("inline flow with missing stages returns error, does not spawn children", async () => {
    const items = ["r"];
    const dispatched: string[] = [];

    const dispatcher = makeDispatcher(async (childId) => {
      dispatched.push(childId);
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const badSpec = { name: "no-stages", stages: [] } as InlineFlowSpec;
    const stage: StageDefinition = {
      name: "per_item",
      for_each: "{{inputs.items}}",
      mode: "spawn",
      iteration_var: "item",
      on_iteration_failure: "stop",
      gate: "auto",
      spawn: {
        flow: badSpec,
        inputs: { value: "{{item}}" },
      },
    };

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    // on_iteration_failure: stop => first iteration fails => overall fails
    expect(result.ok).toBe(false);
    expect(result.message).toContain("stage");
    expect(dispatched).toHaveLength(0);
  });

  it("string flow name still works (regression)", async () => {
    const items = ["s1", "s2"];
    const dispatched: string[] = [];

    const dispatcher = makeDispatcher(async (childId) => {
      dispatched.push(childId);
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    // Use "bare" which is a builtin flow
    const stage: StageDefinition = {
      name: "per_item",
      for_each: "{{inputs.items}}",
      mode: "spawn",
      iteration_var: "item",
      on_iteration_failure: "stop",
      gate: "auto",
      spawn: {
        flow: "bare",
        inputs: { value: "{{item}}" },
      },
    };

    const result = await dispatcher.dispatchForEach(parentId, stage, vars);

    expect(result.ok).toBe(true);
    expect(dispatched).toHaveLength(2);

    const children = await app.sessions.getChildren(parentId);
    for (const child of children) {
      expect(child.flow).toBe("bare");
    }
  });

  it("multiple sibling children each get their own distinct inline flow -- no cross-contamination", async () => {
    const items = ["p1", "p2", "p3"];
    const spawnedIds: string[] = [];

    const dispatcher = makeDispatcher(async (childId) => {
      spawnedIds.push(childId);
      await app.sessions.update(childId, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStageWithInlineFlow(makeInlineFlowSpec("shared-spec"));

    await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(spawnedIds).toHaveLength(3);

    // Each child must have a distinct flow name and its own inline_flow entry
    const children = await app.sessions.getChildren(parentId);
    const flowNames = new Set(children.map((c) => c.flow));
    expect(flowNames.size).toBe(3); // all distinct

    // Each flow name must match the child's id
    for (const child of children) {
      expect(child.flow).toBe(`inline-${child.id}`);
      const def = app.flows.get(child.flow);
      expect(def).not.toBeNull();
      expect(def!.name).toBe(child.flow);
    }
  });
});

describe("inline flow -- daemon restart rehydration", () => {
  it("re-reading the child session recovers the inline_flow definition from config", async () => {
    const items = ["rr1"];
    let childId: string | null = null;

    const dispatcher = makeDispatcher(async (id) => {
      childId = id;
      await app.sessions.update(id, { status: "completed" });
    });

    const { id: parentId, vars } = await makeParentWithList(items);
    const stage = makeStageWithInlineFlow(makeInlineFlowSpec("restart-test"));

    await dispatcher.dispatchForEach(parentId, stage, vars);
    expect(childId).not.toBeNull();

    // The inline_flow field should survive a fresh DB read
    const freshChild = await app.sessions.get(childId!);
    expect(freshChild).not.toBeNull();

    const inlineFlow = (freshChild!.config as Record<string, unknown>)?.inline_flow;
    expect(inlineFlow).toBeDefined();
    expect((inlineFlow as any).name).toBe(`inline-${childId}`);

    // Simulate rehydration: manually call registerInline (what boot does)
    const def = inlineFlow as import("../state/flow.js").FlowDefinition;
    const freshName = `rehydrated-${childId}`;
    def.name = freshName;
    app.flows.registerInline?.(freshName, def);

    const fetched = app.flows.get(freshName);
    expect(fetched).not.toBeNull();
    expect(fetched!.stages[0].name).toBe("do-work");
  });
});
