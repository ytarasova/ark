/**
 * SQLite half of migration 005 -- add `deleted_by TEXT` to every
 * soft-deletable auth entity.
 *
 * SQLite allows `ALTER TABLE ... ADD COLUMN` for TEXT columns without
 * defaults, so we don't need the table-rebuild dance from migration 004.
 * Each table is probed via PRAGMA table_info before altering -- the
 * migration is fully idempotent.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

const TABLES = ["tenants", "users", "teams", "memberships"] as const;

export async function applySqliteDeletedBy(db: DatabaseAdapter): Promise<void> {
  for (const table of TABLES) {
    if (await hasColumn(db, table, "deleted_by")) continue;
    await trySql(db, `ALTER TABLE ${table} ADD COLUMN deleted_by TEXT`);
  }
}

async function hasColumn(db: DatabaseAdapter, table: string, column: string): Promise<boolean> {
  try {
    const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  } catch {
    return false;
  }
}

async function trySql(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "deleted_by column already present");
  }
}
