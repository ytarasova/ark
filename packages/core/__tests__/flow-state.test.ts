import { describe, it, expect } from "bun:test";
import { withTestContext, getApp } from "./test-helpers.js";

withTestContext();

describe("FlowStateRepository", () => {
  it("save and load round-trip", async () => {
    const ts = new Date().toISOString();
    await getApp().flowStates.save({
      sessionId: "s-test",
      flowName: "default",
      completedStages: ["plan"],
      skippedStages: [],
      currentStage: "implement",
      stageResults: {},
      startedAt: ts,
      updatedAt: ts,
    });
    const loaded = await getApp().flowStates.load("s-test");
    expect(loaded).not.toBeNull();
    expect(loaded!.completedStages).toEqual(["plan"]);
    expect(loaded!.currentStage).toBe("implement");
    expect(loaded!.flowName).toBe("default");
  });

  it("markStageCompleted adds to completed list", async () => {
    const repo = getApp().flowStates;
    await repo.setCurrentStage("s-mark", "plan", "default");
    await repo.markStageCompleted("s-mark", "plan");
    expect(await repo.isStageCompleted("s-mark", "plan")).toBe(true);
    expect(await repo.isStageCompleted("s-mark", "implement")).toBe(false);
  });

  it("load returns null for a missing session", async () => {
    expect(await getApp().flowStates.load("nonexistent")).toBeNull();
  });

  it("delete removes the row", async () => {
    const repo = getApp().flowStates;
    await repo.setCurrentStage("s-del", "plan");
    await repo.delete("s-del");
    expect(await repo.load("s-del")).toBeNull();
  });

  it("multiple stages can be completed in order", async () => {
    const repo = getApp().flowStates;
    await repo.setCurrentStage("s-multi", "plan", "default");
    await repo.markStageCompleted("s-multi", "plan");
    await repo.markStageCompleted("s-multi", "implement");
    await repo.markStageCompleted("s-multi", "review");
    const state = (await repo.load("s-multi"))!;
    expect(state.completedStages).toEqual(["plan", "implement", "review"]);
  });

  it("markStagesSkipped records skipped stages and results", async () => {
    const repo = getApp().flowStates;
    await repo.setCurrentStage("s-skip", "plan", "default");
    await repo.markStagesSkipped("s-skip", ["review", "verify"]);
    expect(await repo.getSkippedStages("s-skip")).toEqual(["review", "verify"]);
    const state = (await repo.load("s-skip"))!;
    expect(state.stageResults.review?.status).toBe("skipped");
    expect(state.stageResults.verify?.status).toBe("skipped");
  });

  it("is tenant-scoped (writes from tenant-a are invisible to tenant-b)", async () => {
    const base = getApp().flowStates;
    base.setTenant("tenant-a");
    await base.setCurrentStage("s-shared", "plan", "docs");
    await base.markStageCompleted("s-shared", "plan");

    base.setTenant("tenant-b");
    expect(await base.load("s-shared")).toBeNull();

    base.setTenant("tenant-a");
    const state = (await base.load("s-shared"))!;
    expect(state.completedStages).toEqual(["plan"]);

    // Restore default so later tests aren't affected.
    base.setTenant("default");
  });
});
