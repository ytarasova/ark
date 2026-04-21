import { describe, it, expect } from "bun:test";
import { withTestContext, getApp } from "./test-helpers.js";

withTestContext();

describe("FlowStateRepository", () => {
  it("save and load round-trip", () => {
    const ts = new Date().toISOString();
    getApp().flowStates.save({
      sessionId: "s-test",
      flowName: "default",
      completedStages: ["plan"],
      skippedStages: [],
      currentStage: "implement",
      stageResults: {},
      startedAt: ts,
      updatedAt: ts,
    });
    const loaded = getApp().flowStates.load("s-test");
    expect(loaded).not.toBeNull();
    expect(loaded!.completedStages).toEqual(["plan"]);
    expect(loaded!.currentStage).toBe("implement");
    expect(loaded!.flowName).toBe("default");
  });

  it("markStageCompleted adds to completed list", () => {
    const repo = getApp().flowStates;
    repo.setCurrentStage("s-mark", "plan", "default");
    repo.markStageCompleted("s-mark", "plan");
    expect(repo.isStageCompleted("s-mark", "plan")).toBe(true);
    expect(repo.isStageCompleted("s-mark", "implement")).toBe(false);
  });

  it("load returns null for a missing session", () => {
    expect(getApp().flowStates.load("nonexistent")).toBeNull();
  });

  it("delete removes the row", () => {
    const repo = getApp().flowStates;
    repo.setCurrentStage("s-del", "plan");
    repo.delete("s-del");
    expect(repo.load("s-del")).toBeNull();
  });

  it("multiple stages can be completed in order", () => {
    const repo = getApp().flowStates;
    repo.setCurrentStage("s-multi", "plan", "default");
    repo.markStageCompleted("s-multi", "plan");
    repo.markStageCompleted("s-multi", "implement");
    repo.markStageCompleted("s-multi", "review");
    const state = repo.load("s-multi")!;
    expect(state.completedStages).toEqual(["plan", "implement", "review"]);
  });

  it("markStagesSkipped records skipped stages and results", () => {
    const repo = getApp().flowStates;
    repo.setCurrentStage("s-skip", "plan", "default");
    repo.markStagesSkipped("s-skip", ["review", "verify"]);
    expect(repo.getSkippedStages("s-skip")).toEqual(["review", "verify"]);
    const state = repo.load("s-skip")!;
    expect(state.stageResults.review?.status).toBe("skipped");
    expect(state.stageResults.verify?.status).toBe("skipped");
  });

  it("is tenant-scoped (writes from tenant-a are invisible to tenant-b)", () => {
    const base = getApp().flowStates;
    base.setTenant("tenant-a");
    base.setCurrentStage("s-shared", "plan", "docs");
    base.markStageCompleted("s-shared", "plan");

    base.setTenant("tenant-b");
    expect(base.load("s-shared")).toBeNull();

    base.setTenant("tenant-a");
    const state = base.load("s-shared")!;
    expect(state.completedStages).toEqual(["plan"]);

    // Restore default so later tests aren't affected.
    base.setTenant("default");
  });
});
