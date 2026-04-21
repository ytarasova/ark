/**
 * Postgres half of migration 002 -- unify compute + compute_templates.
 *
 * Adds `is_template` + `cloned_from` columns to `compute` so templates and
 * concrete targets share the same table. Backfills from `compute_templates`
 * with `ON CONFLICT DO NOTHING` so re-runs are safe. The legacy table is
 * NOT dropped -- kept one release as a safety net.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresComputeUnify(db: IDatabase): Promise<void> {
  await tryRun(db, `ALTER TABLE compute ADD COLUMN IF NOT EXISTS is_template BOOLEAN NOT NULL DEFAULT FALSE`);
  await tryRun(db, `ALTER TABLE compute ADD COLUMN IF NOT EXISTS cloned_from TEXT`);

  // Source table may not exist on fresh installs -- tryRun absorbs the error.
  await tryRun(
    db,
    `INSERT INTO compute
       (name, provider, compute_kind, runtime_kind, status, config, is_template, tenant_id, created_at, updated_at)
     SELECT
       name,
       provider,
       COALESCE(NULLIF(provider, ''), 'local'),
       'direct',
       'stopped',
       COALESCE(config, '{}'),
       TRUE,
       COALESCE(tenant_id, 'default'),
       COALESCE(created_at, NOW()::TEXT),
       COALESCE(updated_at, NOW()::TEXT)
     FROM compute_templates
     ON CONFLICT (name) DO NOTHING`,
  );
}

async function tryRun(db: IDatabase, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "compute_unify statement skipped (idempotent or absent source table)");
  }
}
