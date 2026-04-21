/**
 * SQLite half of migration 008 -- add `compute_config_yaml` to `tenant_policies`.
 *
 * SQLite does not support `ADD COLUMN IF NOT EXISTS`. We PRAGMA-probe the
 * column list first so re-running the migration against an install that
 * already has the column (e.g. via the TenantPolicyManager lazy-migration
 * path) is a no-op instead of an error.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteTenantComputeConfig(db: IDatabase): Promise<void> {
  // Make sure the parent table exists. Agent B / legacy code creates this
  // table lazily via TenantPolicyManager; in a pure-migration install the
  // row may not be in place yet.
  await trySql(
    db,
    `CREATE TABLE IF NOT EXISTS tenant_policies (
      tenant_id TEXT PRIMARY KEY,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      default_provider TEXT NOT NULL DEFAULT 'k8s',
      max_concurrent_sessions INTEGER NOT NULL DEFAULT 10,
      max_cost_per_day_usd REAL,
      compute_pools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  );

  if (await hasColumn(db, "tenant_policies", "compute_config_yaml")) {
    logDebug("general", "tenant_policies.compute_config_yaml already present");
    return;
  }
  await trySql(db, "ALTER TABLE tenant_policies ADD COLUMN compute_config_yaml TEXT");
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
    logDebug("general", "tenant_compute_config DDL step skipped");
  }
}
