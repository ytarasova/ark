/**
 * Migration 011 -- sessions.orchestrator column.
 *
 * Adds a dialect-neutral `orchestrator TEXT NOT NULL DEFAULT 'custom'` column
 * to `sessions`. Today the only legal value is `'custom'` (the in-tree state
 * machine in `packages/core/state/flow.ts`); the Temporal-backed orchestrator
 * tracked in #374 will land as a second enum value in a later migration.
 *
 * Introducing the column now means Phase 2 of the temporal cutover doesn't
 * need to ship a schema change alongside the runtime change -- the column is
 * already there, carrying `'custom'` for every existing row.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteSessionOrchestrator } from "./011_session_orchestrator_sqlite.js";
import { applyPostgresSessionOrchestrator } from "./011_session_orchestrator_postgres.js";

export const VERSION = 11;
export const NAME = "session_orchestrator";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteSessionOrchestrator(ctx.db);
  } else {
    await applyPostgresSessionOrchestrator(ctx.db);
  }
}
