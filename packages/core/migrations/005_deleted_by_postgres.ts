/**
 * Postgres half of migration 005 -- add `deleted_by TEXT` to every
 * soft-deletable auth entity.
 *
 * `ADD COLUMN IF NOT EXISTS` makes this trivially idempotent. No index is
 * added -- `deleted_by` is audit metadata, not a lookup key.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

const TABLES = ["tenants", "users", "teams", "memberships"] as const;

export async function applyPostgresDeletedBy(db: IDatabase): Promise<void> {
  for (const table of TABLES) {
    await trySql(db, `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS deleted_by TEXT`);
  }
}

async function trySql(db: IDatabase, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "deleted_by Postgres DDL already applied");
  }
}
