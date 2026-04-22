/**
 * Postgres half of migration 008 -- add `compute_config_yaml` to `tenant_policies`.
 *
 * Postgres supports `ADD COLUMN IF NOT EXISTS`, so no PRAGMA probe is
 * needed. `CREATE TABLE IF NOT EXISTS` ensures the parent exists in a
 * pure-migration install.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresTenantComputeConfig(db: DatabaseAdapter): Promise<void> {
  await runDdl(
    db,
    `CREATE TABLE IF NOT EXISTS tenant_policies (
      tenant_id TEXT PRIMARY KEY,
      allowed_providers TEXT NOT NULL DEFAULT '[]',
      default_provider TEXT NOT NULL DEFAULT 'k8s',
      max_concurrent_sessions INTEGER NOT NULL DEFAULT 10,
      max_cost_per_day_usd DOUBLE PRECISION,
      compute_pools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT now()::text,
      updated_at TEXT NOT NULL DEFAULT now()::text
    )`,
  );
  await runDdl(db, "ALTER TABLE tenant_policies ADD COLUMN IF NOT EXISTS compute_config_yaml TEXT");
}

async function runDdl(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "tenant_compute_config postgres DDL step skipped");
  }
}
