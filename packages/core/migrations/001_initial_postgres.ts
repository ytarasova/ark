/**
 * Postgres half of migration 001 -- canonical Ark schema for postgres.js.
 *
 * Phase 1 reuses the legacy `initPostgresSchema` function as the canonical
 * Postgres bootstrap. Future migrations (002+) apply deltas on top.
 *
 * When the legacy initPostgresSchema is eventually deleted in Phase 2, this
 * module inlines its DDL.
 */

import type { IDatabase } from "../database/index.js";
import { initPostgresSchema } from "../repositories/schema-postgres.js";

export function applyPostgresInitial(db: IDatabase): void {
  // initPostgresSchema is idempotent (CREATE TABLE IF NOT EXISTS) -- safe to
  // invoke from a migration body even though the runner already gates by
  // version.
  initPostgresSchema(db);
}
