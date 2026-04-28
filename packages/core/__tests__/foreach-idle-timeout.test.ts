/**
 * for_each + mode:spawn child timeout: idle-based, not wall-clock.
 *
 * Pre-fix the dispatcher held a fixed 30-min wall-clock deadline. A child
 * that had been actively progressing for 30 min (long Bedrock streams,
 * lengthy bash builds, etc.) would still get killed even though it was
 * on the verge of completing. Real incident: PAI-31995 dispatch on the
 * staging box -- parent timed out at T+30 min, the orphan child finished
 * pushing 21 minutes later. State flipped to "child timed out, continuing"
 * even though the child eventually succeeded.
 *
 * The fix resets the deadline whenever `child.updated_at` advances, so
 * actively progressing children never trip the timeout. Only genuinely
 * silent children give up after the configured idle window. Stage YAML
 * can override the default via `child_timeout_minutes:`.
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
    summary: "idle-timeout test parent",
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

describe("for_each spawn -- idle-based child timeout", () => {
  it("does NOT timeout a child that bumps updated_at within the idle window", async () => {
    const { id: parentId, vars } = await makeParentWithList([{ val: "a" }]);

    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      // Trigger background activity that bumps updated_at every 200ms
      // for ~1.6s before completing. Idle window is 1.5s, so each bump
      // resets the deadline -- the child should NEVER trip the timeout.
      dispatchChild: async (childId: string) => {
        (async () => {
          for (let i = 0; i < 8; i++) {
            await Bun.sleep(200);
            await app.sessions.update(childId, { stage: "implement" });
          }
          await app.sessions.update(childId, { status: "completed" });
        })();
        return { ok: true, message: "started" };
      },
    });

    // 0.025 minutes = 1500ms idle window. Child bumps every 200ms.
    const result = await dispatcher.dispatchForEach(parentId, makeStage({ child_timeout_minutes: 0.025 }), vars);

    expect(result.ok).toBe(true);
    const evts = await app.events.list(parentId, { type: "for_each_iteration_complete" });
    expect(evts.length).toBe(1);
    const failed = await app.events.list(parentId, { type: "for_each_iteration_failed" });
    expect(failed.length).toBe(0);
  }, 15_000);

  it("DOES timeout a child that goes silent for longer than the idle window", async () => {
    const { id: parentId, vars } = await makeParentWithList([{ val: "b" }]);

    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      // Child is dispatched but never progresses, never reaches terminal.
      dispatchChild: async () => ({ ok: true, message: "started but silent" }),
    });

    // Tight idle window: 0.01 minutes = 600ms. Child does nothing -> timeout.
    const result = await dispatcher.dispatchForEach(parentId, makeStage({ child_timeout_minutes: 0.01 }), vars);

    // The single iteration timed out -> failed; parent's outcome is failure
    // (any-iteration-failure-fails-parent rule). on_iteration_failure:
    // continue only governs whether the loop keeps dispatching, not whether
    // the parent's overall outcome counts as success.
    expect(result.ok).toBe(false);
    const failed = await app.events.list(parentId, { type: "for_each_iteration_failed" });
    expect(failed.length).toBe(1);
    expect((failed[0].data as Record<string, unknown>).reason).toContain("timed out");
  }, 15_000);

  it("default idle window is 60 minutes (sanity: timeout much longer than 1s of silence)", async () => {
    // Without `child_timeout_minutes:` set, a child idle for 1 second must
    // not be considered timed out -- the default is 60 minutes. We assert
    // this by completing the child after a brief silence and confirming
    // the iteration succeeds.
    const { id: parentId, vars } = await makeParentWithList([{ val: "c" }]);

    const dispatcher = new ForEachDispatcher({
      sessions: app.sessions,
      events: app.events,
      flows: app.flows,
      dispatchChild: async (childId: string) => {
        (async () => {
          await Bun.sleep(800); // brief silence well under 60-min default
          await app.sessions.update(childId, { status: "completed" });
        })();
        return { ok: true, message: "started" };
      },
    });

    const result = await dispatcher.dispatchForEach(parentId, makeStage(), vars);
    expect(result.ok).toBe(true);
    const failed = await app.events.list(parentId, { type: "for_each_iteration_failed" });
    expect(failed.length).toBe(0);
  }, 10_000);
});
