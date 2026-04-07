/**
 * Flow state persistence — save/restore flow execution state.
 * Auto-saves after each stage completion. Enables resume mid-pipeline.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { ARK_DIR } from "./paths.js";

export interface FlowState {
  sessionId: string;
  flowName: string;
  completedStages: string[];
  currentStage: string | null;
  stageResults: Record<string, { status: string; completedAt: string; data?: Record<string, unknown> }>;
  startedAt: string;
  updatedAt: string;
}

function stateDir(): string {
  return join(ARK_DIR(), "flow-state");
}

function statePath(sessionId: string): string {
  return join(stateDir(), `${sessionId}.json`);
}

/** Save flow execution state. */
export function saveFlowState(state: FlowState): void {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath(state.sessionId), JSON.stringify(state, null, 2));
}

/** Load flow execution state. Returns null if not found. */
export function loadFlowState(sessionId: string): FlowState | null {
  const path = statePath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FlowState;
  } catch { return null; }
}

/** Mark a stage as completed in the flow state. */
export function markStageCompleted(sessionId: string, stageName: string, data?: Record<string, unknown>): void {
  let state = loadFlowState(sessionId);
  if (!state) {
    state = {
      sessionId,
      flowName: "",
      completedStages: [],
      currentStage: stageName,
      stageResults: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  if (!state.completedStages.includes(stageName)) {
    state.completedStages.push(stageName);
  }
  state.stageResults[stageName] = {
    status: "completed",
    completedAt: new Date().toISOString(),
    data,
  };
  state.currentStage = null;
  saveFlowState(state);
}

/** Set the current executing stage. */
export function setCurrentStage(sessionId: string, stageName: string, flowName?: string): void {
  let state = loadFlowState(sessionId);
  if (!state) {
    state = {
      sessionId,
      flowName: flowName ?? "",
      completedStages: [],
      currentStage: stageName,
      stageResults: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  state.currentStage = stageName;
  if (flowName) state.flowName = flowName;
  saveFlowState(state);
}

/** Check if a stage was already completed (for skip-on-resume). */
export function isStageCompleted(sessionId: string, stageName: string): boolean {
  const state = loadFlowState(sessionId);
  return state?.completedStages.includes(stageName) ?? false;
}

/** Delete flow state (on session deletion). */
export function deleteFlowState(sessionId: string): void {
  const path = statePath(sessionId);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* ignore */ }
  }
}
