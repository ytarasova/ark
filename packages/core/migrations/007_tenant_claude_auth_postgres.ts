/**
 * Postgres half of migration 007 -- tenant_claude_auth binding table.
 *
 * Uses CREATE TABLE IF NOT EXISTS so re-running is safe. Mirrors the
 * SQLite CHECK constraint. No FK to tenants for the same reason
 * tenant_policies has none.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresTenantClaudeAuth(db: IDatabase): Promise<void> {
  await trySql(
    db,
    `CREATE TABLE IF NOT EXISTS tenant_claude_auth (
      tenant_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('api_key','subscription_blob')),
      secret_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
}

async function trySql(db: IDatabase, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "tenant_claude_auth Postgres DDL already applied");
  }
}
