/**
 * Shared MigrationsCapability factory used by both local and hosted AppMode.
 *
 * The capability is just a thin adapter around `MigrationRunner` -- it pins
 * the dialect at construction so handlers don't have to know it.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { MigrationRunner } from "../migrations/index.js";
import type { MigrationsCapability } from "./app-mode.js";

export function buildMigrationsCapability(dialect: "sqlite" | "postgres"): MigrationsCapability {
  return {
    dialect,
    async apply(db: DatabaseAdapter, opts?: { targetVersion?: number }): Promise<void> {
      await new MigrationRunner(db, dialect).apply(opts);
    },
    async status(db: DatabaseAdapter) {
      return new MigrationRunner(db, dialect).status();
    },
    async down(db: DatabaseAdapter, opts: { targetVersion: number }): Promise<never> {
      return new MigrationRunner(db, dialect).down(opts);
    },
  };
}
