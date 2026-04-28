/**
 * Pin the per-stage segmented progress strip projection.
 *
 * sessionToListItem() now derives a `stages` field from either
 * flowStagesMap (named flows) or session.config.inline_flow.stages
 * (inline fan-out children). Each segment carries a state of
 * done | active | pending | failed | skipped. The row renders one
 * coloured segment per stage -- GH-Actions style -- replacing the
 * old single solid lane + sparkline combo.
 *
 * The user complaint that drove this change: the previous decorative
 * sparkline duplicated information already conveyed by the progress
 * lane, the right-edge of the strip was clipping inside the selected
 * card, and there was no per-stage signal at a glance.
 */

import { describe, it, expect } from "bun:test";
import { sessionToListItem } from "../SessionList.js";

const flowStagesMap = {
  "plan-then-implement": [{ name: "plan" }, { name: "implement" }],
};

describe("sessionToListItem -- stage segments", () => {
  it("marks stages before the current one done and the current one active while running", () => {
    const item = sessionToListItem(
      { id: "s1", status: "running", flow: "plan-then-implement", stage: "implement" },
      flowStagesMap,
    );
    expect(item.stages).toEqual([
      { name: "plan", state: "done" },
      { name: "implement", state: "active" },
    ]);
  });

  it("marks the current stage failed when the session failed mid-stage", () => {
    const item = sessionToListItem(
      { id: "s1", status: "failed", flow: "plan-then-implement", stage: "implement" },
      flowStagesMap,
    );
    expect(item.stages).toEqual([
      { name: "plan", state: "done" },
      { name: "implement", state: "failed" },
    ]);
  });

  it("marks every stage done when the session completed", () => {
    const item = sessionToListItem(
      { id: "s1", status: "completed", flow: "plan-then-implement", stage: "implement" },
      flowStagesMap,
    );
    expect(item.stages).toEqual([
      { name: "plan", state: "done" },
      { name: "implement", state: "done" },
    ]);
  });

  it("falls back to inline_flow.stages when the flow isn't in flowStagesMap (synthetic inline-s-* names)", () => {
    const item = sessionToListItem(
      {
        id: "s1",
        status: "running",
        flow: "inline-s-abc123",
        stage: "plan",
        config: {
          inline_flow: { stages: [{ name: "plan" }, { name: "implement" }] },
        },
      },
      flowStagesMap, // doesn't contain inline-s-abc123
    );
    expect(item.stages).toEqual([
      { name: "plan", state: "active" },
      { name: "implement", state: "pending" },
    ]);
  });

  it("for_each parent uses server-attached child_iterations to project per-iteration segments", () => {
    // The "ms-stale-worktree" case: parent flow has just `per_stream` (1
    // stage). Server attaches an ordered child_iterations array so the
    // collapsed parent row renders real per-iteration progress without
    // a second round-trip. Segments come straight from the domain
    // projection -- no UI synthesis.
    const item = sessionToListItem(
      {
        id: "p1",
        status: "completed",
        flow: "fanout",
        stage: "per_stream",
        child_stats: { total: 2, completed: 0, failed: 2, running: 0 },
        child_iterations: [
          { id: "c0", status: "failed", for_each_index: 0, created_at: "2026-04-28T10:00:00Z" },
          { id: "c1", status: "failed", for_each_index: 1, created_at: "2026-04-28T10:00:01Z" },
        ],
      },
      { fanout: [{ name: "per_stream" }] },
    );
    expect(item.stages).toEqual([
      { name: "iter 0", state: "failed", sessionId: "c0" },
      { name: "iter 1", state: "failed", sessionId: "c1" },
    ]);
  });

  it("for_each parent: explicit children arg (expanded row) overrides server-attached snapshot", () => {
    // When the row is expanded, useSessionChildrenQuery has fresher status.
    // The 4th arg of sessionToListItem wins over the embedded
    // child_iterations so in-flight transitions render live.
    const item = sessionToListItem(
      {
        id: "p1",
        status: "running",
        flow: "fanout",
        stage: "per_stream",
        child_stats: { total: 2, completed: 0, failed: 0, running: 2 },
        child_iterations: [
          { id: "c0", status: "running", for_each_index: 0, created_at: null },
          { id: "c1", status: "running", for_each_index: 1, created_at: null },
        ],
      },
      { fanout: [{ name: "per_stream" }] },
      undefined,
      // Live children: c0 just transitioned to completed.
      [
        { id: "c0", status: "completed", config: { for_each_index: 0 } },
        { id: "c1", status: "running", config: { for_each_index: 1 } },
      ],
    );
    expect(item.stages?.[0].state).toBe("done");
    expect(item.stages?.[1].state).toBe("active");
  });

  it("returns no stages (single-bar fallback) when neither inline_flow nor flowStagesMap has the flow", () => {
    const item = sessionToListItem(
      { id: "s1", status: "running", flow: "unknown-flow", stage: "x" },
      flowStagesMap,
    );
    expect(item.stages).toBeUndefined();
  });
});
