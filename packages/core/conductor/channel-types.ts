/**
 * Shared types for Ark channel messages.
 * Defines structured events between conductor and agents.
 */

/** Conductor → Agent: task assignment */
export interface TaskAssignment {
  type: "task";
  sessionId: string;
  stage: string;
  agent: string;
  task: string;
  handoff?: {
    previousStages: { stage: string; agent: string; summary?: string }[];
    planMd?: string;
    recentCommits?: string;
  };
}

/** Conductor → Agent: steering message */
export interface SteerMessage {
  type: "steer";
  sessionId: string;
  message: string;
  from: string;
}

/** Conductor → Agent: stop/abort */
export interface AbortMessage {
  type: "abort";
  sessionId: string;
  reason: string;
}

/** Agent → Conductor: progress update */
export interface ProgressReport {
  type: "progress";
  sessionId: string;
  stage: string;
  message: string;
  toolCalls?: number;
  filesChanged?: string[];
  /** GitHub PR URL - set when agent creates a PR */
  pr_url?: string;
}

/** Agent → Conductor: stage completed */
export interface CompletionReport {
  type: "completed";
  sessionId: string;
  stage: string;
  summary: string;
  filesChanged: string[];
  commits: string[];
  cost?: number;
  turns?: number;
  /** GitHub PR URL - set when agent creates a PR */
  pr_url?: string;
}

/** Agent → Conductor: question for human */
export interface QuestionReport {
  type: "question";
  sessionId: string;
  stage: string;
  question: string;
  options?: string[];
}

/** Agent → Conductor: error */
export interface ErrorReport {
  type: "error";
  sessionId: string;
  stage: string;
  error: string;
}

export type InboundMessage = TaskAssignment | SteerMessage | AbortMessage;
export type OutboundMessage = ProgressReport | CompletionReport | QuestionReport | ErrorReport;
export type ChannelMessage = InboundMessage | OutboundMessage;
