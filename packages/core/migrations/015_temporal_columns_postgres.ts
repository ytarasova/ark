/**
 * Postgres half of migration 015 -- adds workflow_id/workflow_run_id columns
 * to sessions and creates the session_projections + session_projections_shadow
 * sidecar tables used by the Temporal shadow projector.
 *
 * session_stages workflow columns are omitted because that table does not yet
 * exist; they will be added when session_stages is introduced.
 *
 * Note: Postgres does not support expressions in PRIMARY KEY constraints either,
 * so the projection tables use a UNIQUE index on (session_id, COALESCE(stage_idx, -1))
 * for the same uniqueness semantics without a nullable-column PK.
 */

import type { DatabaseAdapter } from "../database/index.js";

const STATEMENTS = [
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_id TEXT",
  "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_run_id TEXT",
  `CREATE TABLE IF NOT EXISTS session_projections (
    session_id TEXT NOT NULL,
    stage_idx  INTEGER,
    last_seq   BIGINT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_projections_pk ON session_projections(session_id, COALESCE(stage_idx, -1))",
  `CREATE TABLE IF NOT EXISTS session_projections_shadow (
    session_id TEXT NOT NULL,
    stage_idx  INTEGER,
    last_seq   BIGINT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_projections_shadow_pk ON session_projections_shadow(session_id, COALESCE(stage_idx, -1))",
];

export async function applyPostgresTemporalColumns(db: DatabaseAdapter): Promise<void> {
  for (const sql of STATEMENTS) {
    await db.exec(sql);
  }
}
