/**
 * Pure projection from authoritative session/child state to a `FlowProgress`
 * value. The UI consumes this verbatim -- no second pass of UI-side logic.
 *
 * Two shapes:
 *  - `iterations`: for_each parent + children loaded; one segment per child
 *    ordered by config.for_each_index. Pending slots fill the strip up to
 *    the declared total so width is stable as the loop progresses.
 *  - `stages`: leaf with a multi-stage flow; classic stage walk.
 *
 * Returns null when there isn't enough information (no flow + no children).
 */

import { describe, it, expect } from "bun:test";
import { buildFlowProgress } from "../flow-progress.js";
import type { FlowDefinition } from "../flow.js";

const planThenImplement: FlowDefinition = {
  name: "plan-then-implement",
  stages: [
    { name: "plan", gate: "auto" },
    { name: "implement", gate: "auto" },
  ],
};

const onlyForEach: FlowDefinition = {
  name: "fanout",
  stages: [{ name: "per_stream", gate: "auto" }],
};

describe("buildFlowProgress -- stages projection", () => {
  it("walks a multi-stage flow with the current stage active while running", () => {
    const result = buildFlowProgress({
      session: { id: "s1", status: "running", stage: "implement", config: {} },
      flow: planThenImplement,
    });
    expect(result).toEqual({
      kind: "stages",
      segments: [
        { name: "plan", state: "done" },
        { name: "implement", state: "active" },
      ],
    });
  });

  it("marks the current stage failed mid-flight", () => {
    const result = buildFlowProgress({
      session: { id: "s1", status: "failed", stage: "implement", config: {} },
      flow: planThenImplement,
    });
    expect(result?.segments).toEqual([
      { name: "plan", state: "done" },
      { name: "implement", state: "failed" },
    ]);
  });

  it("marks every stage done when the session completed", () => {
    const result = buildFlowProgress({
      session: { id: "s1", status: "completed", stage: "implement", config: {} },
      flow: planThenImplement,
    });
    expect(result?.segments.map((s) => s.state)).toEqual(["done", "done"]);
  });

  it("returns null when there's no flow info and no children to fall back on", () => {
    const result = buildFlowProgress({
      session: { id: "s1", status: "running", stage: null, config: {} },
      flow: null,
    });
    expect(result).toBeNull();
  });
});

describe("buildFlowProgress -- iterations projection", () => {
  const fanOutSession = {
    id: "p1",
    status: "running",
    stage: "per_stream",
    config: {},
    child_stats: { total: 3, completed: 1, failed: 1, running: 1 },
  };

  it("orders children by config.for_each_index, not by status bucket", () => {
    // The screenshot bug: child_stats counts couldn't tell us iter 0 was the
    // failing one. With real children loaded, the order is canonical.
    const result = buildFlowProgress({
      session: fanOutSession,
      flow: onlyForEach,
      children: [
        { id: "c2", status: "completed", config: { for_each_index: 2 } },
        { id: "c0", status: "failed", config: { for_each_index: 0 } },
        { id: "c1", status: "running", config: { for_each_index: 1 } },
      ],
    });
    expect(result?.kind).toBe("iterations");
    expect(result?.segments).toEqual([
      { name: "iter 0", state: "failed", sessionId: "c0" },
      { name: "iter 1", state: "active", sessionId: "c1" },
      { name: "iter 2", state: "done", sessionId: "c2" },
    ]);
  });

  it("pads pending slots up to child_stats.total when not all iterations have spawned yet", () => {
    const result = buildFlowProgress({
      session: { ...fanOutSession, child_stats: { total: 4, completed: 1, failed: 0, running: 1 } },
      flow: onlyForEach,
      children: [
        { id: "c0", status: "completed", config: { for_each_index: 0 } },
        { id: "c1", status: "running", config: { for_each_index: 1 } },
      ],
    });
    expect(result?.segments).toEqual([
      { name: "iter 0", state: "done", sessionId: "c0" },
      { name: "iter 1", state: "active", sessionId: "c1" },
      { name: "iter 2", state: "pending" },
      { name: "iter 3", state: "pending" },
    ]);
  });

  it("falls back to created_at when for_each_index is missing on some children", () => {
    const result = buildFlowProgress({
      session: { ...fanOutSession, child_stats: { total: 2, completed: 1, failed: 0, running: 1 } },
      flow: onlyForEach,
      children: [
        { id: "later", status: "running", config: {}, created_at: "2026-04-28T12:01:00Z" },
        { id: "earlier", status: "completed", config: {}, created_at: "2026-04-28T12:00:00Z" },
      ],
    });
    expect(result?.segments.map((s) => s.sessionId)).toEqual(["earlier", "later"]);
  });

  it("falls through to stages when the parent has children counts but no children have been loaded yet", () => {
    // child_stats says total=2 but caller hasn't fetched children. We don't
    // have ground truth for ordering -- prefer the parent's own flow walk
    // (1 segment for `per_stream`) over fabricating iteration positions.
    const result = buildFlowProgress({
      session: fanOutSession,
      flow: onlyForEach,
      children: undefined,
    });
    expect(result?.kind).toBe("stages");
    expect(result?.segments).toEqual([{ name: "per_stream", state: "active" }]);
  });

  it("returns null when neither flow nor children are available", () => {
    const result = buildFlowProgress({
      session: fanOutSession,
      flow: null,
      children: undefined,
    });
    expect(result).toBeNull();
  });
});
