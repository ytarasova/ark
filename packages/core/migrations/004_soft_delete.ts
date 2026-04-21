/**
 * Migration 004 -- soft-delete for every auditable auth entity.
 *
 * Hard `DELETE FROM tenants|teams|users|memberships` destroys audit trails
 * and breaks referential integrity for sessions / events / messages that
 * already carry the entity id. This migration introduces `deleted_at` on
 * all four tables so removal becomes `UPDATE ... SET deleted_at = now()`
 * and any caller that wants the tombstone back later can `restore(id)`.
 *
 * Uniqueness constraints were simple UNIQUEs (tenants.slug, users.email,
 * teams(tenant_id, slug), memberships(user_id, team_id)). Once a row is
 * soft-deleted, recreating it with the same natural key must still work.
 * We replace each full UNIQUE with a partial unique index:
 *
 *   CREATE UNIQUE INDEX ... WHERE deleted_at IS NULL
 *
 * Both engines support partial unique indexes via the WHERE clause:
 *   - SQLite since 3.8.0 (2013) -- bun:sqlite bundles a modern version.
 *   - Postgres since 7.2 (2001) -- universally available.
 *
 * SQLite cannot DROP a table-level UNIQUE in place, so the SQLite half of
 * this migration rebuilds each affected table with the column added and
 * the UNIQUE removed, then re-creates the partial indexes. Postgres can
 * ALTER TABLE DROP CONSTRAINT + ADD COLUMN in place.
 *
 * No backfill -- existing rows stay live (`deleted_at IS NULL`).
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteSoftDelete } from "./004_soft_delete_sqlite.js";
import { applyPostgresSoftDelete } from "./004_soft_delete_postgres.js";

export const VERSION = 4;
export const NAME = "soft_delete";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteSoftDelete(ctx.db);
  } else {
    await applyPostgresSoftDelete(ctx.db);
  }
}
