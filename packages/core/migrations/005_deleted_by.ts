/**
 * Migration 005 -- add `deleted_by` audit column to every soft-deletable auth
 * entity.
 *
 * Migration 004 introduced soft-delete (`deleted_at`) for tenants / users /
 * teams / memberships. That captures *when* a row was removed, but not
 * *who* did it. For audit trails we need the deleter's user id stored
 * alongside the timestamp -- so admin UIs and log pipelines can answer
 * "who revoked tenant X" without cross-referencing an event stream.
 *
 * Shape:
 *   - Column type: `TEXT`, nullable. Matches the `deleted_at TEXT` convention.
 *   - Null means either "not deleted" OR "deleted by the system / pre-audit"
 *     (older rows that were already soft-deleted before this migration ran).
 *   - When the admin handler passes `ctx.userId`, managers write it into
 *     `deleted_by`. When the caller is local / unauthenticated, managers
 *     write NULL ("system" deleter).
 *
 * Both SQLite and Postgres support `ALTER TABLE ... ADD COLUMN` in place,
 * so no table rebuild is needed here (unlike 004 which had to drop a
 * table-level UNIQUE).
 *
 * Idempotent: both halves probe for the column before adding it.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteDeletedBy } from "./005_deleted_by_sqlite.js";
import { applyPostgresDeletedBy } from "./005_deleted_by_postgres.js";

export const VERSION = 5;
export const NAME = "deleted_by";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteDeletedBy(ctx.db);
  } else {
    await applyPostgresDeletedBy(ctx.db);
  }
}
