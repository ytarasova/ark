/**
 * Shared MigrationsCapability factory used by both local and hosted AppMode.
 *
 * The capability is just a thin adapter around `MigrationRunner` -- it pins
 * the dialect at construction so handlers don't have to know it.
 */

import type { IDatabase } from "../database/index.js";
import { MigrationRunner } from "../migrations/index.js";
import type { MigrationsCapability } from "./app-mode.js";

export function buildMigrationsCapability(dialect: "sqlite" | "postgres"): MigrationsCapability {
  return {
    dialect,
    apply(db: IDatabase, opts?: { targetVersion?: number }) {
      new MigrationRunner(db, dialect).apply(opts);
    },
    status(db: IDatabase) {
      return new MigrationRunner(db, dialect).status();
    },
    down(db: IDatabase, opts: { targetVersion: number }): never {
      return new MigrationRunner(db, dialect).down(opts);
    },
  };
}
