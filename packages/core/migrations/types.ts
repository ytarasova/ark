/**
 * Migration types -- shared shape for the global Ark migration runner.
 *
 * Each migration is a TypeScript module exporting `VERSION`, `NAME`, and `up`.
 * The runner passes a `MigrationApplyContext` carrying the database adapter
 * and the active dialect so the migration body can branch on dialect when
 * needed (e.g. `INTEGER PRIMARY KEY AUTOINCREMENT` vs `SERIAL PRIMARY KEY`).
 *
 * Down/rollback is intentionally not part of Phase 1. The interface stub is
 * documented in the runner so callers know it's coming, but no migration
 * has to implement it yet.
 */

import type { IDatabase } from "../database/index.js";

export type MigrationDialect = "sqlite" | "postgres";

export interface MigrationApplyContext {
  db: IDatabase;
  dialect: MigrationDialect;
}

export interface Migration {
  version: number;
  name: string;
  up(ctx: MigrationApplyContext): void;
}

export interface MigrationStatus {
  currentVersion: number;
  pending: Array<{ version: number; name: string }>;
  applied: Array<{ version: number; name: string; applied_at: string }>;
}

export interface MigrationRunOptions {
  /** Stop after applying the named version. Default: apply everything pending. */
  targetVersion?: number;
}
