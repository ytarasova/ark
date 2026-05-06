/**
 * Migration 015 -- drop the legacy `provider` columns from `compute` +
 * `compute_templates`, drop the `idx_compute_provider` index.
 *
 * This is the database half of Task 5 of the compute cleanup. After this
 * migration runs:
 *
 *   - `compute.provider` is gone. Dispatch reads `compute_kind` +
 *     `isolation_kind` directly. Repos no longer synthesize the column
 *     from `pairToProvider` (the entire `adapters/` directory is deleted
 *     in the same change set).
 *   - `compute_templates.provider` is gone. The new two-axis fields
 *     (`compute_kind`, `isolation_kind`) replace it. The table is mostly
 *     vestigial (rows live on `compute` with `is_template = 1` since
 *     migration 002), but its row shape stays in sync with `compute` so
 *     legacy callers keep type-checking.
 *   - `idx_compute_provider` is gone (had been used to drive the
 *     singleton-per-provider lookup in `ComputeRepository.findByProvider`).
 *
 * The firecracker data fixup runs first, BEFORE the column drops, so the
 * legacy `provider` field is still queryable for diagnostic logging if
 * anything goes wrong: any row whose `isolation_kind` is the previously
 * coerced `firecracker-in-container` literal (whether the compute_kind
 * was `local` or `ec2`) is rewritten to `compute_kind='firecracker'` +
 * `isolation_kind='direct'`. This matches Task 4's intent to flatten
 * "firecracker as isolation" into "firecracker as compute kind" so
 * `app.getCompute('firecracker')` resolves to the registered
 * FirecrackerCompute impl rather than falling back to LocalCompute.
 *
 * Hosted policy columns (`tenant_policies.allowed_providers`,
 * `tenant_policies.default_provider`, `compute_pools.provider`) are NOT
 * touched here. They store provider-name strings that overlap with the
 * legacy single-axis names, but their callers (the hosted scheduler) are
 * a separate refactor surface. Future work converts them to compute_kind +
 * isolation_kind tuples.
 *
 * Idempotency: SQLite's `ALTER TABLE DROP COLUMN` (3.35+) errors when the
 * column is missing; bun:sqlite ships SQLite 3.46+, but `IF EXISTS` is not
 * supported on `DROP COLUMN`, so we wrap the drop in a try/catch and treat
 * "no such column" as benign (already-dropped). The same swallow applies
 * to the index drop.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteDropLegacyProviderColumns } from "./015_drop_legacy_provider_columns_sqlite.js";
import { applyPostgresDropLegacyProviderColumns } from "./015_drop_legacy_provider_columns_postgres.js";

export const VERSION = 15;
export const NAME = "drop_legacy_provider_columns";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteDropLegacyProviderColumns(ctx.db);
  } else {
    await applyPostgresDropLegacyProviderColumns(ctx.db);
  }
}
