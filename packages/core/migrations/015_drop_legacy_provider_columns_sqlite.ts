/**
 * SQLite half of migration 015 -- drop the legacy `provider` columns from
 * `compute` + `compute_templates` and drop the matching index.
 *
 * Order:
 *   1. Firecracker data fixup. Rows with the legacy "firecracker as
 *      isolation" shape get rewritten to "firecracker as compute kind"
 *      so `app.getCompute('firecracker')` resolves to FirecrackerCompute.
 *      Done first so the legacy `provider` column is still queryable for
 *      diagnostics if a row needs manual inspection.
 *   2. Drop `idx_compute_provider`.
 *   3. Drop `compute.provider`.
 *   4. Drop `compute_templates.provider`.
 *
 * SQLite 3.35+ supports `ALTER TABLE ... DROP COLUMN` natively (and
 * bun:sqlite ships 3.46+), so we don't need the
 * recreate-table-and-copy-rows dance. The drops are wrapped to swallow
 * "no such column" so re-runs are idempotent (SQLite's DROP COLUMN
 * doesn't accept IF EXISTS).
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteDropLegacyProviderColumns(db: DatabaseAdapter): Promise<void> {
  // 1. Firecracker data fixup. Idempotent: rows already on (firecracker, direct)
  //    or (k8s, ...) are untouched.
  await db
    .prepare(
      `UPDATE compute
        SET compute_kind = 'firecracker',
            isolation_kind = 'direct'
        WHERE compute_kind = 'local' AND isolation_kind = 'firecracker-in-container'`,
    )
    .run();
  await db
    .prepare(
      `UPDATE compute_templates
        SET compute_kind = 'firecracker',
            isolation_kind = 'direct'
        WHERE compute_kind = 'local' AND isolation_kind = 'firecracker-in-container'`,
    )
    .run();

  // 2. Drop the index that fed `findByProvider`. IF EXISTS is supported here.
  await runDdl(db, "DROP INDEX IF EXISTS idx_compute_provider");

  // 3 + 4. Drop the legacy `provider` columns. Swallow "no such column" for
  //         idempotent re-runs.
  await dropColumnIfExists(db, "compute", "provider");
  await dropColumnIfExists(db, "compute_templates", "provider");
}

async function runDdl(db: DatabaseAdapter, sql: string): Promise<void> {
  await db.exec(sql);
}

async function dropColumnIfExists(db: DatabaseAdapter, table: string, column: string): Promise<void> {
  try {
    await runDdl(db, `ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/no such column|cannot drop column/i.test(msg)) throw e;
    logDebug("general", `${table}.${column} already dropped: ${msg}`);
  }
}
