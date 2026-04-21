/**
 * Migration 002 -- unify compute + compute_templates.
 *
 * Adds `is_template` and `cloned_from` columns to the `compute` table and
 * backfills existing `compute_templates` rows as templates. After this
 * migration, both compute targets and compute templates live in the same
 * table, distinguished only by the `is_template` flag.
 *
 * The legacy `compute_templates` table is NOT dropped -- kept one release
 * as a safety net. A follow-up migration will drop it once the delegation
 * adapter is removed.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteComputeUnify } from "./002_compute_unify_sqlite.js";
import { applyPostgresComputeUnify } from "./002_compute_unify_postgres.js";

export const VERSION = 2;
export const NAME = "compute_unify";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteComputeUnify(ctx.db);
  } else {
    await applyPostgresComputeUnify(ctx.db);
  }
}
