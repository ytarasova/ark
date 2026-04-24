/**
 * Postgres half of migration 011 -- adds sessions.orchestrator column.
 *
 * Semantics mirror the SQLite variant. Postgres IF NOT EXISTS on ALTER TABLE
 * ADD COLUMN is built-in, so we use it instead of catching a duplicate-column
 * error from the driver.
 */

import type { DatabaseAdapter } from "../database/index.js";

const ALTER_SQL = "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS orchestrator TEXT NOT NULL DEFAULT 'custom'";

export async function applyPostgresSessionOrchestrator(db: DatabaseAdapter): Promise<void> {
  await db.exec(ALTER_SQL);
}
