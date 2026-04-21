import type { IDatabase } from "../database/index.js";
import { now } from "../util/time.js";

export interface StageResult {
  status: string;
  completedAt: string;
  data?: Record<string, unknown>;
}

export interface FlowState {
  sessionId: string;
  flowName: string;
  completedStages: string[];
  skippedStages: string[];
  currentStage: string | null;
  stageResults: Record<string, StageResult>;
  startedAt: string;
  updatedAt: string;
}

/** Raw row as stored in the flow_state table (JSON blobs kept as strings). */
interface FlowStateRow {
  session_id: string;
  tenant_id: string;
  flow_name: string;
  completed_stages: string;
  skipped_stages: string;
  current_stage: string | null;
  stage_results: string;
  started_at: string;
  updated_at: string;
}

function rowToState(row: FlowStateRow): FlowState {
  return {
    sessionId: row.session_id,
    flowName: row.flow_name,
    completedStages: parseJson<string[]>(row.completed_stages, []),
    skippedStages: parseJson<string[]>(row.skipped_stages, []),
    currentStage: row.current_stage,
    stageResults: parseJson<Record<string, StageResult>>(row.stage_results, {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/**
 * DAG orchestration state for a session's flow run. Tracks completed +
 * skipped stages, current stage, and per-stage results. Replaces the old
 * filesystem-backed `flow-state.ts` module so the state travels with the
 * session row (tenant-scoped, replica-shared, survives pod restart).
 *
 * The primary key is `session_id`; there is at most one flow-state row per
 * session. `tenant_id` is stamped from `setTenant` so cross-tenant reads
 * are impossible even if a stale session id leaks.
 */
export class FlowStateRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  /** Load the flow-state row for a session. Returns null if none exists. */
  load(sessionId: string): FlowState | null {
    const row = this.db
      .prepare("SELECT * FROM flow_state WHERE session_id = ? AND tenant_id = ?")
      .get(sessionId, this.tenantId) as FlowStateRow | undefined;
    return row ? rowToState(row) : null;
  }

  /**
   * Upsert a fully-formed flow-state row. Stamps `updated_at`. Callers
   * usually go through the helpers below (`markStageCompleted`, ...) which
   * load + mutate + save.
   */
  save(state: FlowState): void {
    const ts = now();
    const row: FlowStateRow = {
      session_id: state.sessionId,
      tenant_id: this.tenantId,
      flow_name: state.flowName,
      completed_stages: JSON.stringify(state.completedStages),
      skipped_stages: JSON.stringify(state.skippedStages),
      current_stage: state.currentStage,
      stage_results: JSON.stringify(state.stageResults),
      started_at: state.startedAt,
      updated_at: ts,
    };
    // Portable upsert: the IDatabase adapter handles SQLite vs Postgres parameter binding.
    this.db
      .prepare(
        `INSERT INTO flow_state (
           session_id, tenant_id, flow_name, completed_stages, skipped_stages,
           current_stage, stage_results, started_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           flow_name = excluded.flow_name,
           completed_stages = excluded.completed_stages,
           skipped_stages = excluded.skipped_stages,
           current_stage = excluded.current_stage,
           stage_results = excluded.stage_results,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.session_id,
        row.tenant_id,
        row.flow_name,
        row.completed_stages,
        row.skipped_stages,
        row.current_stage,
        row.stage_results,
        row.started_at,
        row.updated_at,
      );
  }

  /** Mark a stage as completed + record its result. Clears `currentStage`. */
  markStageCompleted(sessionId: string, stageName: string, data?: Record<string, unknown>): void {
    const state = this.load(sessionId) ?? this.seed(sessionId, stageName, "");
    if (!state.completedStages.includes(stageName)) {
      state.completedStages.push(stageName);
    }
    state.stageResults[stageName] = {
      status: "completed",
      completedAt: now(),
      data,
    };
    state.currentStage = null;
    this.save(state);
  }

  /** Mark stages as skipped (not on the active conditional path). */
  markStagesSkipped(sessionId: string, stageNames: string[]): void {
    const state = this.load(sessionId) ?? this.seed(sessionId, null, "");
    for (const name of stageNames) {
      if (!state.skippedStages.includes(name)) {
        state.skippedStages.push(name);
      }
      state.stageResults[name] = {
        status: "skipped",
        completedAt: now(),
      };
    }
    this.save(state);
  }

  /** Return the skipped-stage list for a session (empty when no row). */
  getSkippedStages(sessionId: string): string[] {
    return this.load(sessionId)?.skippedStages ?? [];
  }

  /** Set the currently-executing stage. Seeds the row if it doesn't exist. */
  setCurrentStage(sessionId: string, stageName: string, flowName?: string): void {
    const state = this.load(sessionId) ?? this.seed(sessionId, stageName, flowName ?? "");
    state.currentStage = stageName;
    if (flowName) state.flowName = flowName;
    this.save(state);
  }

  /** True iff `stageName` is recorded as completed for this session. */
  isStageCompleted(sessionId: string, stageName: string): boolean {
    return this.load(sessionId)?.completedStages.includes(stageName) ?? false;
  }

  /**
   * Delete the flow-state row entirely. Used on session delete and on a
   * rewind-Restart so the DAG starts over (otherwise `getReadyStages`
   * stalls at a phantom join-barrier because every stage is still marked
   * completed).
   */
  delete(sessionId: string): void {
    this.db.prepare("DELETE FROM flow_state WHERE session_id = ? AND tenant_id = ?").run(sessionId, this.tenantId);
  }

  /** Build a zero-state FlowState for the seed path in the mutators. */
  private seed(sessionId: string, currentStage: string | null, flowName: string): FlowState {
    const ts = now();
    return {
      sessionId,
      flowName,
      completedStages: [],
      skippedStages: [],
      currentStage,
      stageResults: {},
      startedAt: ts,
      updatedAt: ts,
    };
  }
}
