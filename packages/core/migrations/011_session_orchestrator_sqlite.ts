/**
 * SQLite half of migration 011 -- adds sessions.orchestrator column.
 *
 * Today the only legal value is 'custom'. Existing rows default to 'custom'
 * via the column default; no backfill is required.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteSessionOrchestrator(db: DatabaseAdapter): Promise<void> {
  // SQLite ALTER TABLE ADD COLUMN is portable; NOT NULL DEFAULT 'custom'
  // applies retroactively to every existing row.
  try {
    await db.exec("ALTER TABLE sessions ADD COLUMN orchestrator TEXT NOT NULL DEFAULT 'custom'");
  } catch (e: any) {
    // Re-run safety: a previous attempt may have added the column before the
    // apply-log row was committed. "duplicate column name" is benign.
    const msg = String(e?.message ?? e);
    if (!/duplicate column name/i.test(msg)) throw e;
    logDebug("general", "orchestrator column already present -- skipping");
  }
}
