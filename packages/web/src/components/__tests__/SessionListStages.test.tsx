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

  it("returns no stages (single-bar fallback) when neither inline_flow nor flowStagesMap has the flow", () => {
    const item = sessionToListItem(
      { id: "s1", status: "running", flow: "unknown-flow", stage: "x" },
      flowStagesMap,
    );
    expect(item.stages).toBeUndefined();
  });
});
