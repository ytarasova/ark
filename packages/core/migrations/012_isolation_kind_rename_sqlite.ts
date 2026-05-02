/**
 * SQLite half of migration 012 -- renames compute.runtime_kind to
 * compute.isolation_kind and recreates the matching index.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteIsolationKindRename(db: DatabaseAdapter): Promise<void> {
  // SQLite 3.25+ supports ALTER TABLE RENAME COLUMN; bun:sqlite ships a
  // recent enough build. A second run hits "duplicate column name" /
  // "no such column" -- both benign, swallow.
  try {
    await db.exec("ALTER TABLE compute RENAME COLUMN runtime_kind TO isolation_kind");
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!/no such column|duplicate column name/i.test(msg)) throw e;
    logDebug("general", "compute.runtime_kind already renamed: " + msg);
  }

  // Drop the old index name (if any) and recreate against the new column.
  // IF EXISTS / IF NOT EXISTS make this idempotent across re-runs.
  await db.exec("DROP INDEX IF EXISTS idx_compute_runtime_kind");
  await db.exec("CREATE INDEX IF NOT EXISTS idx_compute_isolation_kind ON compute(isolation_kind)");
}
