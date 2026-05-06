/**
 * Migration 012 -- rename `compute.runtime_kind` to `compute.isolation_kind`.
 *
 * The column was originally named `runtime_kind` after the `Runtime` interface
 * in packages/core/compute/types.ts. That collided in code with the agent-
 * runtime concept (claude-code / codex / gemini / goose) one layer up; the
 * compute-side abstraction was renamed `Isolation` for clarity. This
 * migration aligns the column name with the new TS contract so the storage
 * layer matches the in-memory shape.
 *
 * SQLite 3.25+ and Postgres both support `ALTER TABLE ... RENAME COLUMN`, so
 * the rename is a single DDL on each side. The accompanying index
 * `idx_compute_runtime_kind` is dropped + recreated under the new name.
 */

import type { MigrationApplyContext } from "./types.js";
import { applySqliteIsolationKindRename } from "./012_isolation_kind_rename_sqlite.js";
import { applyPostgresIsolationKindRename } from "./012_isolation_kind_rename_postgres.js";

export const VERSION = 12;
export const NAME = "isolation_kind_rename";

export async function up(ctx: MigrationApplyContext): Promise<void> {
  if (ctx.dialect === "sqlite") {
    await applySqliteIsolationKindRename(ctx.db);
  } else {
    await applyPostgresIsolationKindRename(ctx.db);
  }
}
