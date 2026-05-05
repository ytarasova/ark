/**
 * Shared types + Deps interface for the stage-advance pipeline.
 *
 * `StageAdvanceDeps` enumerates the narrow capabilities the sub-classes
 * actually read. Callbacks wrap helpers that still take `AppContext`
 * (dispatch, executeAction, runVerification, blob/skill-extraction helpers).
 * Those callbacks are wired at the container-registration layer where a
 * single `c.app` reference is acceptable; the class itself never sees
 * AppContext.
 *
 * Why each field:
 *   - sessions/events/messages/todos/flowStates: direct DB writes the
 *     advance + complete bodies perform on every transition.
 *   - flows/runtimes/transcriptParsers: pure read-only registries used to
 *     resolve stage definitions and non-Claude transcript parsers.
 *   - usageRecorder: aggregates session cost at flow-complete span-end.
 *   - config: only field read is `config.dirs.worktrees` for capturePlanMd.
 *   - db: idempotency ledger (`stage_operations`) still reads raw SQL;
 *     follow-up PR routes this through a `LedgerRepository`.
 *   - dispatch / executeAction / runVerification / recordSessionUsage /
 *     sessionClone: service callbacks. Passed as narrow function refs so
 *     StageAdvance never holds a back-ref to AppContext / SessionLifecycle
 *     directly. Breaks the StageAdvance <-> SessionLifecycle cycle.
 *   - capturePlanMd / gcComputeIfTemplate: orchestration-side helpers that
 *     still take AppContext upstream. Wrapped at registration time.
 *   - getStage / getStageAction / resolveNextStage / evaluateGate:
 *     the flow-state helpers in `state/flow.ts` take AppContext today
 *     (for resource-store lookups). Wrapped as narrow callbacks so the
 *     class bodies stay `app`-free.
 */

import type { ArkConfig } from "../../config.js";
import type { Session } from "../../../types/index.js";
import type { SessionRepository } from "../../repositories/session.js";
import type { EventRepository } from "../../repositories/event.js";
import type { MessageRepository } from "../../repositories/message.js";
import type { TodoRepository } from "../../repositories/todo.js";
import type { FlowStateRepository } from "../../repositories/flow-state.js";
import type { FlowStore } from "../../stores/flow-store.js";
import type { RuntimeStore } from "../../stores/runtime-store.js";
import type { UsageRecorder } from "../../observability/usage.js";
import type { TranscriptParserRegistry } from "../../runtimes/transcript-parser.js";
import type { DatabaseAdapter } from "../../database/index.js";
import type { StageDefinition, StageAction } from "../../state/flow.js";

// ── Callbacks ───────────────────────────────────────────────────────────────

export interface DispatchCb {
  (sessionId: string): Promise<{ ok: boolean; message: string }>;
}
export interface ExecuteActionCb {
  (sessionId: string, action: string, opts?: { idempotencyKey?: string }): Promise<{ ok: boolean; message: string }>;
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
export interface SessionCloneCb {
  (sessionId: string, newName?: string): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }>;
}
export interface CapturePlanMdCb {
  (session: Session): Promise<void>;
}
export interface GcComputeIfTemplateCb {
  (computeName: string | null | undefined): Promise<boolean>;
}
export interface SaveCheckpointCb {
  (sessionId: string): Promise<void>;
}
export interface GetStageCb {
  (flowName: string, stageName: string): StageDefinition | null;
}
export interface GetStageActionCb {
  (flowName: string, stageName: string): StageAction;
}
export interface ResolveNextStageCb {
  (flowName: string, stage: string, outcome?: string): string | null;
}
export interface EvaluateGateCb {
  (flowName: string, stage: string, session: Session): { canProceed: boolean; reason: string };
}
export interface StopStatusPollerCb {
  (sessionId: string): void;
}

// ── Deps ────────────────────────────────────────────────────────────────────

export interface StageAdvanceDeps {
  // Repositories -- direct DB writes by advance/complete.
  sessions: SessionRepository;
  events: EventRepository;
  messages: MessageRepository;
  todos: TodoRepository;
  flowStates: FlowStateRepository;

  // Stores -- read-only registries for flow + runtime + transcript-parser lookups.
  flows: FlowStore;
  runtimes: RuntimeStore;
  transcriptParsers: TranscriptParserRegistry;

  // Observability aggregator.
  usageRecorder: UsageRecorder;

  // Config -- only `config.dirs.worktrees` reads via the capturePlanMd callback
  // consume this today; still need to pass for `repo-config` + logs.
  config: ArkConfig;

  // Idempotency ledger reads raw SQL. RF-9 smell -- a follow-up PR moves this
  // to `LedgerRepository`. Kept here so this migration stays mechanical.
  db: DatabaseAdapter;

  // Service callbacks -- break the SessionLifecycle <-> StageAdvance cycle
  // and the AppContext back-ref.
  dispatch: DispatchCb;
  executeAction: ExecuteActionCb;
  runVerification: VerifyCb;
  recordSessionUsage: RecordUsageCb;
  sessionClone: SessionCloneCb;

  // Orchestration-side helpers that still take AppContext upstream.
  capturePlanMd: CapturePlanMdCb;
  gcComputeIfTemplate: GcComputeIfTemplateCb;
  saveCheckpoint: SaveCheckpointCb;

  // Flow-engine callbacks (state/flow.ts helpers take AppContext today).
  getStage: GetStageCb;
  getStageAction: GetStageActionCb;
  resolveNextStage: ResolveNextStageCb;
  evaluateGate: EvaluateGateCb;

  // Optional: stop the previous stage's status poller before clearing
  // session_id on the session row. Without this the old poller keeps
  // polling a stale handle until its mismatch guard self-terminates it.
  // Wired in di/services.ts to app.statusPollers.stop.
  stopStatusPoller?: StopStatusPollerCb;
}

// ── Public result shapes (stable; re-exported from the barrel) ──────────────

/**
 * Optional idempotency key accepted by advance/complete/handoff. When a caller
 * (e.g. a Temporal activity with at-least-once delivery) passes the same key
 * twice, the second call returns the cached result without running the body.
 * Omitting the key preserves today's behavior exactly. See RF-8 / #388.
 */
export interface IdempotencyCapable {
  idempotencyKey?: string;
}

export interface StageOpResult {
  ok: boolean;
  message: string;
}
