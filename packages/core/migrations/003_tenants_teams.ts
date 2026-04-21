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
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteTenantsTeams } from "./003_tenants_teams_sqlite.js";
import { applyPostgresTenantsTeams } from "./003_tenants_teams_postgres.js";

export const VERSION = 3;
export const NAME = "tenants_teams";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteTenantsTeams(ctx.db);
  } else {
    await applyPostgresTenantsTeams(ctx.db);
  }
}
