export interface SessionWorkflowInput {
  sessionId: string;
  tenantId: string;
  flowName: string;
  inputs?: { files?: Record<string, string>; params?: Record<string, string> };
}

export interface StageWorkflowInput {
  parentSessionId: string;
  childSessionId: string;
  tenantId: string;
  stageIdx: number;
  stageName: string;
  task: string;
  agent?: string;
}

export interface StartSessionResult {
  sessionId: string;
}

export interface DispatchStageResult {
  launchPid?: number;
  launchId?: string;
}

export interface StageCompletionResult {
  status: "completed" | "failed" | "stopped";
  outcome?: string;
  error?: string;
}

export interface ProjectionInput {
  sessionId: string;
  stageIdx?: number;
  seq: number;
  patch: Record<string, unknown>;
}
