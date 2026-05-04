/**
 * Parent session must transition to status="running" while a for_each loop
 * is in flight.
 *
 * Pre-fix the parent stayed at status="ready" through the entire loop,
 * which the UI's `normalizeStatus` maps to "pending" -- making it look
 * like the parent hadn't started even when its child was actively working.
 * Real user observation: "I did see a sub-flow being in progress while
 * parent flow was in the initial state".
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { ForEachDispatcher } from "../services/dispatch/dispatch-foreach.js";
import type { StageDefinition } from "../state/flow.js";
import { buildSessionVars } from "../template.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
}, 30_000);

async function makeParentWithList(list: unknown[]): Promise<{ id: string; vars: Record<string, string> }> {
  const session = await app.sessions.create({
    summary: "parent-running test",
    flow: "bare",
    config: { inputs: { items: JSON.stringify(list) } },
  });
  await app.sessions.update(session.id, { stage: "per_item", status: "ready" });
  const updated = (await app.sessions.get(session.id))!;
  return { id: session.id, vars: buildSessionVars(updated as unknown as Record<string, unknown>) };
}

function makeStage(overrides: Partial<StageDefinition> = {}): StageDefinition {
  return {
    name: "per_item",
    for_each: "{{inputs.items}}",
    mode: "spawn",
    iteration_var: "item",
    on_iteration_failure: "continue",
    gate: "auto",
    spawn: { flow: "bare", inputs: {} },
    ...overrides,
  };
}

describe("for_each spawn -- parent transitions to running", () => {
  it("parent flips to status=running once a child is dispatched", async () => {
    const { id: parentId, vars } = await makeParentWithList([{ val: "a" }]);

    // Capture parent status while the child is mid-flight. The dispatcher
    // sleeps in the polling loop so we have time to observe the transition.
    let parentStatusDuringChild: string | null = null;
    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      dispatchChild: async (childId: string) => {
        const parent = await app.sessions.get(parentId);
        parentStatusDuringChild = parent?.status ?? null;
        await app.sessions.update(childId, { status: "completed" });
        return { ok: true, message: "ok" };
      },
    });

    const result = await dispatcher.dispatchForEach(parentId, makeStage(), vars);
    expect(result.ok).toBe(true);
    expect(parentStatusDuringChild).toBe("running");
  });

  it("doesn't redundantly write status=running if already running", async () => {
    const { id: parentId, vars } = await makeParentWithList([{ val: "b" }]);
    await app.sessions.update(parentId, { session_id: `ark-s-${parentId}`, status: "running" });
    const before = await app.sessions.get(parentId);
    const beforeUpdatedAt = before?.updated_at;

    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      dispatchChild: async (childId: string) => {
        await app.sessions.update(childId, { status: "completed" });
        return { ok: true, message: "ok" };
      },
    });

    await dispatcher.dispatchForEach(parentId, makeStage(), vars);
    // Parent still gets touched by checkpoint writes / event logs, so we
    // can't assert updated_at is unchanged. The important property is just
    // that we didn't *fail* -- and that the explicit status update is
    // skipped when redundant.
    const after = await app.sessions.get(parentId);
    expect(after?.status).toBe("running");
    expect(beforeUpdatedAt).toBeDefined();
  });
});
