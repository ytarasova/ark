import { describe, it, expect } from "bun:test";
import { saveFlowState, loadFlowState, markStageCompleted, setCurrentStage, isStageCompleted, deleteFlowState } from "../flow-state.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("flow state persistence", () => {
  it("save and load round-trip", () => {
    const state = { sessionId: "s-test", flowName: "default", completedStages: ["plan"], currentStage: "implement", stageResults: {}, startedAt: new Date().toISOString(), updatedAt: "" };
    saveFlowState(state);
    const loaded = loadFlowState("s-test");
    expect(loaded).not.toBeNull();
    expect(loaded!.completedStages).toEqual(["plan"]);
  });

  it("markStageCompleted adds to completed list", () => {
    setCurrentStage("s-mark", "plan", "default");
    markStageCompleted("s-mark", "plan");
    expect(isStageCompleted("s-mark", "plan")).toBe(true);
    expect(isStageCompleted("s-mark", "implement")).toBe(false);
  });

  it("loadFlowState returns null for missing", () => {
    expect(loadFlowState("nonexistent")).toBeNull();
  });

  it("deleteFlowState removes the file", () => {
    setCurrentStage("s-del", "plan");
    deleteFlowState("s-del");
    expect(loadFlowState("s-del")).toBeNull();
  });

  it("multiple stages can be completed", () => {
    setCurrentStage("s-multi", "plan", "default");
    markStageCompleted("s-multi", "plan");
    markStageCompleted("s-multi", "implement");
    markStageCompleted("s-multi", "review");
    const state = loadFlowState("s-multi")!;
    expect(state.completedStages).toEqual(["plan", "implement", "review"]);
  });
});
