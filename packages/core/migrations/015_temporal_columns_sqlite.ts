/**
 * SQLite half of migration 015 -- adds workflow_id/workflow_run_id columns to
 * sessions and creates the session_projections + session_projections_shadow
 * sidecar tables used by the Temporal shadow projector.
 *
 * session_stages workflow columns are omitted because that table does not yet
 * exist; they will be added when session_stages is introduced.
 *
 * Note: SQLite does not support expressions (e.g. COALESCE) in PRIMARY KEY
 * constraints, so the projection tables use a UNIQUE index instead of a
 * composite PRIMARY KEY with a nullable column.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

async function addColumnSafe(db: DatabaseAdapter, sql: string, columnName: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/duplicate column name/i.test(msg)) throw e;
    logDebug("general", `${columnName} column already present -- skipping`);
  }
}

export async function applySqliteTemporalColumns(db: DatabaseAdapter): Promise<void> {
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN workflow_id TEXT", "sessions.workflow_id");
  await addColumnSafe(db, "ALTER TABLE sessions ADD COLUMN workflow_run_id TEXT", "sessions.workflow_run_id");

  await db.exec(`CREATE TABLE IF NOT EXISTS session_projections (
    session_id TEXT NOT NULL,
    stage_idx  INTEGER,
    last_seq   INTEGER NOT NULL
  )`);
  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_projections_pk ON session_projections(session_id, COALESCE(stage_idx, -1))",
  );

  await db.exec(`CREATE TABLE IF NOT EXISTS session_projections_shadow (
    session_id TEXT NOT NULL,
    stage_idx  INTEGER,
    last_seq   INTEGER NOT NULL
  )`);
  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_projections_shadow_pk ON session_projections_shadow(session_id, COALESCE(stage_idx, -1))",
  );
}
