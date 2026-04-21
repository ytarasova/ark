/**
 * SQLite half of migration 001 -- canonical Ark schema for bun:sqlite.
 *
 * Phase 1 reuses the legacy `initSchema` function as the canonical SQLite
 * bootstrap. Future migrations (002+) apply deltas on top.
 *
 * When the legacy initSchema is eventually deleted in Phase 2, this module
 * inlines its DDL.
 */

import type { IDatabase } from "../database/index.js";
import { initSchema } from "../repositories/schema.js";

export async function applySqliteInitial(db: IDatabase): Promise<void> {
  // initSchema is idempotent (CREATE TABLE IF NOT EXISTS throughout) -- safe
  // to invoke from a migration body even though the runner already gates by
  // version.
  await initSchema(db);
}
