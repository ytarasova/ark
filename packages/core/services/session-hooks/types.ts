/**
 * Shared types + Deps interface for the session-hooks pipeline.
 *
 * `SessionHooksDeps` enumerates the narrow capabilities that the three
 * sub-classes actually read. Callbacks are used for the still-AppContext-
 * taking helpers (`advance`, `dispatch`, `runVerification`, ...). Those
 * are wired at the container-registration layer where a single `c.app`
 * reference is acceptable; the hooks class itself never sees AppContext.
 */

import type { SessionRepository } from "../../repositories/session.js";
import type { EventRepository } from "../../repositories/event.js";
import type { MessageRepository } from "../../repositories/message.js";
import type { TodoRepository } from "../../repositories/todo.js";
import type { FlowStore } from "../../stores/flow-store.js";
import type { UsageRecorder } from "../../observability/usage.js";
import type { TranscriptParserRegistry } from "../../runtimes/transcript-parser.js";
import type { Session, MessageRole, MessageType } from "../../../types/index.js";
import type { StageDefinition, StageAction } from "../../state/flow.js";

// ── Callbacks for helpers that still take AppContext ────────────────────────

export interface StageAdvanceCb {
  (sessionId: string, force?: boolean, outcome?: string): Promise<{ ok: boolean; message: string }>;
}
export interface DispatchCb {
  (sessionId: string): Promise<void>;
}
export interface ExecuteActionCb {
  (sessionId: string, action: string): Promise<{ ok: boolean; message: string }>;
}
export interface VerifyCb {
  (sessionId: string): Promise<{ ok: boolean; message: string }>;
}
export interface RecordUsageCb {
  (
    session: Session,
    usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number },
    provider: string,
    source: string,
  ): void;
}
export interface GetOutputCb {
  (sessionId: string, opts?: { lines?: number }): Promise<string>;
}
export interface GetStageCb {
  (flowName: string, stageName: string): StageDefinition | null;
}
export interface GetStageActionCb {
  (flowName: string, stageName: string): StageAction;
}

// ── Deps ────────────────────────────────────────────────────────────────────

export interface SessionHooksDeps {
  sessions: SessionRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  flows: FlowStore;
  usageRecorder: UsageRecorder;
  transcriptParsers: TranscriptParserRegistry;

  // Callbacks to helpers still on the AppContext surface.
  advance: StageAdvanceCb;
  dispatch: DispatchCb;
  executeAction: ExecuteActionCb;
  runVerification: VerifyCb;
  recordSessionUsage: RecordUsageCb;
  getOutput: GetOutputCb;
  getStage: GetStageCb;
  getStageAction: GetStageActionCb;
}

// ── Public result shapes (stable; re-exported from the barrel) ──────────────

export interface HookStatusResult {
  newStatus?: string;
  shouldIndex?: boolean;
  claudeSessionId?: string;
  /** Store updates to apply */
  updates?: Partial<Session>;
  /** Events to log */
  events?: Array<{ type: string; opts: { actor?: string; stage?: string; data?: Record<string, unknown> } }>;
  /** Transcript indexing info */
  indexTranscript?: { transcriptPath: string; sessionId: string };
  /** Whether to call advance() after applying updates (auto-gate SessionEnd fallback) */
  shouldAdvance?: boolean;
  /** Whether to auto-dispatch next stage after advance */
  shouldAutoDispatch?: boolean;
  /** Whether the failure should trigger an on_failure retry loop */
  shouldRetry?: boolean;
  /** Max retries from the on_failure directive (e.g. retry(3) -> 3) */
  retryMaxRetries?: number;
  /** Mark all messages as read (terminal states) */
  markRead?: boolean;
}

export interface ReportResult {
  /** Store updates to apply to the session */
  updates: Partial<Session>;
  /** Whether to call session.advance() after applying updates */
  shouldAdvance?: boolean;
  /** Whether to auto-dispatch next stage after advance */
  shouldAutoDispatch?: boolean;
  /** Stage outcome label for on_outcome routing (from CompletionReport.outcome) */
  outcome?: string;
  /** Events to emit on the event bus */
  busEvents?: Array<{ type: string; sessionId: string; data: Record<string, unknown> }>;
  /** Events to log to the store */
  logEvents?: Array<{ type: string; opts: { stage?: string; actor?: string; data?: Record<string, unknown> } }>;
  /** Message to store for chat view */
  message?: { role: MessageRole; content: string; type: MessageType };
  /** PR URL detected from report */
  prUrl?: string;
  /** Whether the error should trigger an on_failure retry loop */
  shouldRetry?: boolean;
  /** Max retries from the on_failure directive (e.g. retry(3) -> 3) */
  retryMaxRetries?: number;
}

export interface StageHandoffResult {
  /** Whether the handoff completed successfully */
  ok: boolean;
  /** Human-readable outcome message */
  message: string;
  /** The stage we advanced from (null if handoff was skipped) */
  fromStage?: string | null;
  /** The stage we advanced to (null if flow completed) */
  toStage?: string | null;
  /** Whether dispatch was triggered for the next stage */
  dispatched?: boolean;
  /** Whether the handoff was blocked by verification */
  blockedByVerification?: boolean;
  /** Whether the flow completed (no more stages) */
  flowCompleted?: boolean;
}

// ── Small shared helpers ────────────────────────────────────────────────────

/**
 * Parse an on_failure directive string.
 * Supports: "retry(N)" where N is max retry count, or "notify" (no retry).
 * Returns null if the directive doesn't indicate retry.
 */
export function parseOnFailure(directive: string | undefined): { retry: true; maxRetries: number } | null {
  if (!directive) return null;
  const match = directive.match(/^retry\((\d+)\)$/);
  if (!match) return null;
  return { retry: true, maxRetries: parseInt(match[1], 10) };
}
