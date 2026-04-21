/**
 * Migration 003 -- tenants + users + teams + memberships.
 *
 * Before this migration, `tenant_id` was a free-form string scattered across
 * `sessions`, `computes`, `tenant_policies`, etc. There was no tenants table --
 * it was implicit. This migration makes tenants a first-class entity so teams
 * and memberships can hang off a real FK, and backfills the tenants table from
 * every distinct `tenant_id` already in use.
 *
 * Notes:
 *   - No FK is added from sessions / computes to tenants (yet). Those tables
 *     carry string ids from a long history of installs; adding an FK at this
 *     stage risks breaking current deploys. Follow-up migration once the
 *     tenants table is stable.
 *   - The default tenant ("default") is always inserted so existing rows
 *     that use `tenant_id = 'default'` have a matching parent.
 *   - teams + memberships both hard-cascade on parent delete. The tenants
 *     table does NOT cascade to sessions/computes -- too destructive.
 *   - Defense-in-depth: the body skips itself when the migrations log
 *     already records version >= 3. The MigrationRunner already gates on
 *     version, but the backfill (`SELECT DISTINCT tenant_id FROM sessions`
 *     + friends) is expensive enough on live Postgres (~45-90s observed)
 *     that an extra guard pays for itself if anything ever calls `up()`
 *     outside the runner.
 */

import type { IDatabase } from "../database/index.js";
import type { MigrationApplyContext } from "./types.js";
import { applySqliteTenantsTeams } from "./003_tenants_teams_sqlite.js";
import { applyPostgresTenantsTeams } from "./003_tenants_teams_postgres.js";
import { MIGRATIONS_TABLE } from "./runner.js";

export const VERSION = 3;
export const NAME = "tenants_teams";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (await alreadyApplied(ctx.db)) return;
  if (ctx.dialect === "sqlite") {
    await applySqliteTenantsTeams(ctx.db);
  } else {
    await applyPostgresTenantsTeams(ctx.db);
  }
}

/**
 * Returns true when `ark_schema_migrations` already has a row for version
 * VERSION. We swallow errors because the migrations table might not exist
 * yet on an extremely fresh DB (the runner creates it, but `up()` could in
 * theory be called from a test or tool that doesn't).
 */
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
