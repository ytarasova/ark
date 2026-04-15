/**
 * Flow state persistence — save/restore flow execution state.
 * Auto-saves after each stage completion. Enables resume mid-pipeline.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { AppContext } from "../app.js";

export interface FlowState {
  sessionId: string;
  flowName: string;
  completedStages: string[];
  skippedStages: string[];
  currentStage: string | null;
  stageResults: Record<string, { status: string; completedAt: string; data?: Record<string, unknown> }>;
  startedAt: string;
  updatedAt: string;
}

function stateDir(app: AppContext): string {
  return join(app.config.arkDir, "flow-state");
}

function statePath(app: AppContext, sessionId: string): string {
  return join(stateDir(app), `${sessionId}.json`);
}

/** Save flow execution state. */
export function saveFlowState(app: AppContext, state: FlowState): void {
  const dir = stateDir(app);
  mkdirSync(dir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(statePath(app, state.sessionId), JSON.stringify(state, null, 2));
}

/** Load flow execution state. Returns null if not found. */
export function loadFlowState(app: AppContext, sessionId: string): FlowState | null {
  const path = statePath(app, sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FlowState;
  } catch {
    return null;
  }
}

/** Mark a stage as completed in the flow state. */
export function markStageCompleted(
  app: AppContext,
  sessionId: string,
  stageName: string,
  data?: Record<string, unknown>,
): void {
  let state = loadFlowState(app, sessionId);
  if (!state) {
    state = {
      sessionId,
      flowName: "",
      completedStages: [],
      skippedStages: [],
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
  saveFlowState(app, state);
}

/** Mark stages as skipped (not on the active conditional path). */
export function markStagesSkipped(app: AppContext, sessionId: string, stageNames: string[]): void {
  let state = loadFlowState(app, sessionId);
  if (!state) {
    state = {
      sessionId,
      flowName: "",
      completedStages: [],
      skippedStages: [],
      currentStage: null,
      stageResults: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  for (const name of stageNames) {
    if (!state.skippedStages.includes(name)) {
      state.skippedStages.push(name);
    }
    state.stageResults[name] = {
      status: "skipped",
      completedAt: new Date().toISOString(),
    };
  }
  saveFlowState(app, state);
}

/** Get skipped stages for a session. */
export function getSkippedStages(app: AppContext, sessionId: string): string[] {
  const state = loadFlowState(app, sessionId);
  return state?.skippedStages ?? [];
}

/** Set the current executing stage. */
export function setCurrentStage(app: AppContext, sessionId: string, stageName: string, flowName?: string): void {
  let state = loadFlowState(app, sessionId);
  if (!state) {
    state = {
      sessionId,
      flowName: flowName ?? "",
      completedStages: [],
      skippedStages: [],
      currentStage: stageName,
      stageResults: {},
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  state.currentStage = stageName;
  if (flowName) state.flowName = flowName;
  saveFlowState(app, state);
}

/** Check if a stage was already completed (for skip-on-resume). */
export function isStageCompleted(app: AppContext, sessionId: string, stageName: string): boolean {
  const state = loadFlowState(app, sessionId);
  return state?.completedStages.includes(stageName) ?? false;
}

/** Delete flow state (on session deletion). */
export function deleteFlowState(app: AppContext, sessionId: string): void {
  const path = statePath(app, sessionId);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}
