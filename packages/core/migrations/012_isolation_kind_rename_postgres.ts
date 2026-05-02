/**
 * Postgres half of migration 012 -- renames compute.runtime_kind to
 * compute.isolation_kind and recreates the matching index.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresIsolationKindRename(db: DatabaseAdapter): Promise<void> {
  // Postgres always supports ALTER TABLE RENAME COLUMN.
  try {
    await db.exec("ALTER TABLE compute RENAME COLUMN runtime_kind TO isolation_kind");
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // "column ... does not exist" => already renamed (idempotent re-run);
    // "column ... already exists" => prior partial run that committed the
    // rename but not the apply-log row.
    if (!/does not exist|already exists/i.test(msg)) throw e;
    logDebug("general", "compute.runtime_kind already renamed: " + msg);
  }

  await db.exec("DROP INDEX IF EXISTS idx_compute_runtime_kind");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_compute_isolation_kind ON compute(isolation_kind)");
}
