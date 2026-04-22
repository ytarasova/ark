/**
 * SQLite half of migration 010 -- stage_operations table for idempotency keys.
 *
 * Records the result of a side-effectful orchestration call (advance, complete,
 * handoff, executeAction) so that at-least-once activity retries (Temporal) can
 * no-op on replay. Uniqueness is enforced on
 * `(session_id, stage, op_kind, idempotency_key)`.
 *
 * `result_json` is the serialized `{ok, message, ...}` shape the original call
 * returned. Retries deserialize + return the same value without running the
 * body.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteStageOperations(db: DatabaseAdapter): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stage_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT '',
      op_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await tryRun(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_operations_unique
       ON stage_operations(session_id, stage, op_kind, idempotency_key)`,
  );
  await tryRun(db, `CREATE INDEX IF NOT EXISTS idx_stage_operations_session ON stage_operations(session_id)`);
}

async function tryRun(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "stage_operations index create skipped (benign)");
  }
}
