/**
 * SQLite half of migration 006 -- soft-delete for `api_keys`.
 *
 * Steps:
 *   1. ADD COLUMN deleted_at TEXT (idempotent via PRAGMA probe).
 *   2. ADD COLUMN deleted_by TEXT (idempotent via PRAGMA probe).
 *   3. CREATE UNIQUE INDEX idx_api_keys_hash_live ON api_keys(key_hash)
 *      WHERE deleted_at IS NULL.
 *
 * We intentionally do NOT drop the legacy non-unique `idx_api_keys_hash`
 * index -- it's a pure lookup accelerator and leaving it in place preserves
 * SELECT performance while the new partial unique index adds uniqueness
 * among live rows. The two coexist cleanly in sqlite_master.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteApiKeysSoftDelete(db: IDatabase): Promise<void> {
  if (!(await hasColumn(db, "api_keys", "deleted_at"))) {
    await trySql(db, "ALTER TABLE api_keys ADD COLUMN deleted_at TEXT");
  }
  if (!(await hasColumn(db, "api_keys", "deleted_by"))) {
    await trySql(db, "ALTER TABLE api_keys ADD COLUMN deleted_by TEXT");
  }
  await trySql(
    db,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash_live ON api_keys(key_hash) WHERE deleted_at IS NULL",
  );
}

async function hasColumn(db: IDatabase, table: string, column: string): Promise<boolean> {
  try {
    const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function trySql(db: IDatabase, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "api_keys soft-delete DDL already applied");
  }
}
