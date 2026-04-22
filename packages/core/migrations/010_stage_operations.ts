/**
 * Migration 010 -- stage_operations (idempotency key ledger).
 *
 * Tracks every side-effectful orchestration call -- advance, complete, handoff,
 * executeAction -- keyed by `(session_id, stage, op_kind, idempotency_key)`.
 * When an at-least-once activity retry hits a row that already exists, the
 * caller short-circuits and returns the cached `result_json` instead of
 * re-running the body. Details: RF-8 / #388.
 *
 * Passing no `idempotencyKey` preserves today's behavior exactly -- no row is
 * written, no lookup happens.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteStageOperations } from "./010_stage_operations_sqlite.js";
import { applyPostgresStageOperations } from "./010_stage_operations_postgres.js";

export const VERSION = 10;
export const NAME = "stage_operations";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteStageOperations(ctx.db);
  } else {
    await applyPostgresStageOperations(ctx.db);
  }
}
