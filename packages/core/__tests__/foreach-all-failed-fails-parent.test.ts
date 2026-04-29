/**
 * Any iteration failure means the parent's stage outcome is a failure.
 * `on_iteration_failure: continue` only controls whether the loop keeps
 * dispatching after a failure -- it doesn't make the parent's overall
 * outcome succeed. The dispatcher must report ok:false whenever at
 * least one iteration failed so mediateStageHandoff transitions the
 * parent to status="failed".
 *
 * Pre-fix: a fan-out with 0 successes + 2 failures rendered as a green
 * "completed inline" pill over a row whose children both failed (the
 * "ms-stale-worktree" screenshot). Same applied to any partial-failure
 * mix -- 1 succeeded / 2 failed showed up as completed.
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
    summary: "all-failed test",
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

describe("for_each spawn -- any failure propagates ok:false", () => {
  it("returns ok:false when every iteration failed", async () => {
    const { id: parentId, vars } = await makeParentWithList([{ val: "a" }, { val: "b" }]);
    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      dispatchChild: async (childId: string) => {
        await app.sessions.update(childId, { status: "failed", error: "test failure" });
        return { ok: false, message: "iteration failed" };
      },
    });

    const result = await dispatcher.dispatchForEach(parentId, makeStage(), vars);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("2 of 2 iterations failed");
  });

  it("returns ok:false when at least one iteration failed (mixed outcome is still failure)", async () => {
    const { id: parentId, vars } = await makeParentWithList([{ val: "a" }, { val: "b" }]);
    let calls = 0;
    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      dispatchChild: async (childId: string) => {
        const isFirst = calls++ === 0;
        if (isFirst) {
          await app.sessions.update(childId, { status: "completed" });
          return { ok: true, message: "ok" };
        }
        await app.sessions.update(childId, { status: "failed", error: "test failure" });
        return { ok: false, message: "iteration failed" };
      },
    });

    const result = await dispatcher.dispatchForEach(parentId, makeStage(), vars);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("1 of 2 iterations failed");
    expect(result.message).toContain("1 succeeded");
  });

  it("returns ok:true only when every iteration succeeded", async () => {
    const { id: parentId, vars } = await makeParentWithList([{ val: "a" }]);
    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      dispatchChild: async (childId: string) => {
        await app.sessions.update(childId, { status: "completed" });
        return { ok: true, message: "ok" };
      },
    });

    const result = await dispatcher.dispatchForEach(parentId, makeStage(), vars);
    expect(result.ok).toBe(true);
  });
});
