import { describe, it, expect } from "bun:test";
import {
  saveFlowState,
  loadFlowState,
  markStageCompleted,
  setCurrentStage,
  isStageCompleted,
  deleteFlowState,
} from "../state/flow-state.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("flow state persistence", () => {
  it("save and load round-trip", () => {
    const state = {
      sessionId: "s-test",
      flowName: "default",
      completedStages: ["plan"],
      currentStage: "implement",
      stageResults: {},
      startedAt: new Date().toISOString(),
      updatedAt: "",
    };
    saveFlowState(getApp(), state);
    const loaded = loadFlowState(getApp(), "s-test");
    expect(loaded).not.toBeNull();
    expect(loaded!.completedStages).toEqual(["plan"]);
  });

  it("markStageCompleted adds to completed list", () => {
    setCurrentStage(getApp(), "s-mark", "plan", "default");
    markStageCompleted(getApp(), "s-mark", "plan");
    expect(isStageCompleted(getApp(), "s-mark", "plan")).toBe(true);
    expect(isStageCompleted(getApp(), "s-mark", "implement")).toBe(false);
  });

  it("loadFlowState returns null for missing", () => {
    expect(loadFlowState(getApp(), "nonexistent")).toBeNull();
  });

  it("deleteFlowState removes the file", () => {
    setCurrentStage(getApp(), "s-del", "plan");
    deleteFlowState(getApp(), "s-del");
    expect(loadFlowState(getApp(), "s-del")).toBeNull();
  });

  it("multiple stages can be completed", () => {
    setCurrentStage(getApp(), "s-multi", "plan", "default");
    markStageCompleted(getApp(), "s-multi", "plan");
    markStageCompleted(getApp(), "s-multi", "implement");
    markStageCompleted(getApp(), "s-multi", "review");
    const state = loadFlowState(getApp(), "s-multi")!;
    expect(state.completedStages).toEqual(["plan", "implement", "review"]);
  });
});
