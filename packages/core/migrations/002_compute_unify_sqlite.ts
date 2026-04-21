/**
 * SQLite half of migration 002 -- unify compute + compute_templates.
 *
 * Adds `is_template` + `cloned_from` columns to `compute` so templates and
 * concrete targets share the same table. Migrates existing rows from the
 * legacy `compute_templates` table into `compute` with `is_template = 1`.
 * The legacy table is NOT dropped -- kept one release as a safety net.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteComputeUnify(db: IDatabase): Promise<void> {
  // Add columns idempotently. SQLite has no ADD COLUMN IF NOT EXISTS, so
  // swallow the "duplicate column name" error that fires on re-runs.
  await tryRun(db, "ALTER TABLE compute ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0");
  await tryRun(db, "ALTER TABLE compute ADD COLUMN cloned_from TEXT");

  // Copy every row from compute_templates into compute with is_template = 1.
  // INSERT OR IGNORE skips rows that already exist (by primary key `name`)
  // so re-running is safe and never clobbers a newer same-named row.
  await tryRun(
    db,
    `INSERT OR IGNORE INTO compute
       (name, provider, compute_kind, runtime_kind, status, config, is_template, tenant_id, created_at, updated_at)
     SELECT
       name,
       provider,
       COALESCE(NULLIF(provider, ''), 'local') AS compute_kind,
       'direct' AS runtime_kind,
       'stopped' AS status,
       COALESCE(config, '{}') AS config,
       1 AS is_template,
       COALESCE(tenant_id, 'default') AS tenant_id,
       COALESCE(created_at, datetime('now')) AS created_at,
       COALESCE(updated_at, datetime('now')) AS updated_at
     FROM compute_templates`,
  );
}

async function tryRun(db: IDatabase, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    // Expected on re-runs (duplicate column) or fresh installs where
    // compute_templates never existed. Matches the idempotent semantics
    // used elsewhere in schema.ts.
    logDebug("general", "compute_unify statement skipped (idempotent or absent source table)");
  }
}
