/**
 * Migration 008 -- `tenant_policies.compute_config_yaml` column.
 *
 * Adds a nullable TEXT column to `tenant_policies` carrying the YAML blob of
 * per-tenant cluster overrides (see `packages/core/config/clusters.ts`).
 *
 * Defense-in-depth: the body short-circuits when the apply log already
 * records version >= 8. The runner already gates on version, but an idempotent
 * guard here keeps accidental direct `up()` calls cheap.
 *
 * Both dialects use their respective IF NOT EXISTS idiom so the migration is
 * safe to re-run.
 */

import type { IDatabase } from "../database/index.js";
import type { MigrationApplyContext } from "./types.js";
import { applySqliteTenantComputeConfig } from "./008_tenant_compute_config_sqlite.js";
import { applyPostgresTenantComputeConfig } from "./008_tenant_compute_config_postgres.js";
import { MIGRATIONS_TABLE } from "./runner.js";

export const VERSION = 8;
export const NAME = "tenant_compute_config";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (await alreadyApplied(ctx.db)) return;
  if (ctx.dialect === "sqlite") {
    await applySqliteTenantComputeConfig(ctx.db);
  } else {
    await applyPostgresTenantComputeConfig(ctx.db);
  }
}

async function alreadyApplied(db: IDatabase): Promise<boolean> {
  try {
    const row = (await db
      .prepare(`SELECT 1 AS present FROM ${MIGRATIONS_TABLE} WHERE version >= ? LIMIT 1`)
      .get(VERSION)) as { present: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}
