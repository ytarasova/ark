/**
 * Migration 001 -- canonical Ark schema bootstrap.
 *
 * Captures the union of the legacy `repositories/schema.ts` (SQLite) and
 * `repositories/schema-postgres.ts` (Postgres) modules in a single migration.
 *
 * Backwards compat: existing installs already ran the old `initSchema` -- the
 * runner detects this via the presence of the `compute` table and marks 001
 * as applied without re-executing the body. See `runner.ts:apply()`.
 *
 * Idempotent: every CREATE is `IF NOT EXISTS`. Safe on partially-built DBs.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteInitial } from "./001_initial_sqlite.js";
import { applyPostgresInitial } from "./001_initial_postgres.js";

export const VERSION = 1;
export const NAME = "initial";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteInitial(ctx.db);
  } else {
    await applyPostgresInitial(ctx.db);
  }
}
