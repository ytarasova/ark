/**
 * Migration 007 -- `tenant_claude_auth` binding table.
 *
 * Records, per tenant, whether sessions dispatched on behalf of that tenant
 * should use an Anthropic API-key secret or a multi-file subscription
 * blob. Single-valued per tenant by design: changing modes overwrites the
 * prior binding but never deletes the referenced secret / blob (operators
 * frequently want to rebind later).
 *
 * Columns:
 *   tenant_id TEXT PRIMARY KEY
 *   kind TEXT CHECK (kind IN ('api_key','subscription_blob'))
 *   secret_ref TEXT     -- name of the secret OR blob in the tenant's
 *                          secrets backend. Not a path -- just the leaf.
 *   created_at TEXT
 *   updated_at TEXT
 *
 * No FK to `tenants` (mirrors the tenant_policies table); tenant id lives
 * as a free-form string in the rest of the schema so tying this one table
 * to the tenants FK would break down-level rows that predate tenants
 * becoming a first-class entity (migration 003).
 *
 * Idempotent on both engines:
 *   - SQLite: PRAGMA probe gates CREATE TABLE + ADD COLUMN.
 *   - Postgres: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteTenantClaudeAuth } from "./007_tenant_claude_auth_sqlite.js";
import { applyPostgresTenantClaudeAuth } from "./007_tenant_claude_auth_postgres.js";

export const VERSION = 7;
export const NAME = "tenant_claude_auth";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteTenantClaudeAuth(ctx.db);
  } else {
    await applyPostgresTenantClaudeAuth(ctx.db);
  }
}
