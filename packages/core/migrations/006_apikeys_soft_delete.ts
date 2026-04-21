/**
 * Migration 006 -- soft-delete for `api_keys`.
 *
 * `api_keys` is the last auditable auth entity that still hard-DELETEs on
 * revoke. Losing the row destroys the audit trail (who was using the key,
 * when it was last validated, when it was revoked). This migration applies
 * the same soft-delete pattern used for tenants / users / teams /
 * memberships in migration 004:
 *
 *   - Add `deleted_at TEXT` (when) and `deleted_by TEXT` (who).
 *   - Replace the non-unique `idx_api_keys_hash` lookup index with a
 *     partial UNIQUE index `idx_api_keys_hash_live` scoped to live rows
 *     (`WHERE deleted_at IS NULL`). Uniqueness by key_hash *among live
 *     rows* is a genuine invariant -- validation looks keys up by hash and
 *     must never match a tombstone.
 *
 * `api_keys` had no other UNIQUE constraints (tenant + name was free-form,
 * so two keys in the same tenant could legitimately share a name). We
 * don't introduce one here.
 *
 * Idempotent across engines:
 *   - SQLite probes PRAGMA table_info + CREATE INDEX IF NOT EXISTS.
 *   - Postgres uses ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT
 *     EXISTS.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteApiKeysSoftDelete } from "./006_apikeys_soft_delete_sqlite.js";
import { applyPostgresApiKeysSoftDelete } from "./006_apikeys_soft_delete_postgres.js";

export const VERSION = 6;
export const NAME = "apikeys_soft_delete";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteApiKeysSoftDelete(ctx.db);
  } else {
    await applyPostgresApiKeysSoftDelete(ctx.db);
  }
}
