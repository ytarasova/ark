/**
 * Postgres half of migration 010 -- stage_operations table for idempotency keys.
 *
 * See 010_stage_operations_sqlite.ts for semantics. The Postgres variant uses
 * `BIGSERIAL` for `id`; `created_at` stays plain TEXT (ISO-8601) for parity
 * with every other timestamp column in Ark's schema.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresStageOperations(db: DatabaseAdapter): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS stage_operations (
      id BIGSERIAL PRIMARY KEY,
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
