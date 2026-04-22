/**
 * Postgres half of migration 006 -- soft-delete for `api_keys`.
 *
 * Uses `IF NOT EXISTS` on every statement so re-running is safe. The
 * partial unique index guards live-row uniqueness on `key_hash`; the
 * legacy `idx_api_keys_hash` non-unique lookup index is preserved.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresApiKeysSoftDelete(db: DatabaseAdapter): Promise<void> {
  await trySql(db, "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted_at TEXT");
  await trySql(db, "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS deleted_by TEXT");
  await trySql(
    db,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash_live ON api_keys(key_hash) WHERE deleted_at IS NULL",
  );
}

async function trySql(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "api_keys soft-delete Postgres DDL already applied");
  }
}
