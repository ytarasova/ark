/**
 * Migration 015 -- Temporal workflow columns + projection sidecar tables.
 *
 * Adds workflow_id and workflow_run_id to sessions (nullable, populated when
 * the Temporal orchestrator takes over a session). Creates session_projections
 * and session_projections_shadow for the shadow projector diff harness.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteTemporalColumns } from "./015_temporal_columns_sqlite.js";
import { applyPostgresTemporalColumns } from "./015_temporal_columns_postgres.js";

export const VERSION = 15;
export const NAME = "temporal_columns";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteTemporalColumns(ctx.db);
  } else {
    await applyPostgresTemporalColumns(ctx.db);
  }
}
