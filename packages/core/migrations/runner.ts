/**
 * MigrationRunner -- applies the global Ark migration stream in order.
 *
 * Two-axis design:
 *   1. Dialect (sqlite | postgres) is bound at construction. The runner is
 *      polymorphic; downstream code never branches on dialect.
 *   2. Version (monotonic integer) -- each migration applies exactly once,
 *      tracked in `ark_schema_migrations`.
 *
 * Backwards compat for pre-migration installs: if the apply log doesn't
 * exist BUT a known legacy table (`compute`) is present, we treat the DB
 * as already on version 1 and create the apply log accordingly. See
 * `apply()`.
 *
 * Phase 1 does not implement rollback; `down()` throws. The interface is
 * stubbed so callers (CLI) compile against a stable shape.
 */

import type { IDatabase } from "../database/index.js";
import type {
  Migration,
  MigrationApplyContext,
  MigrationDialect,
  MigrationRunOptions,
  MigrationStatus,
} from "./types.js";
import { MIGRATIONS } from "./registry.js";

export const MIGRATIONS_TABLE = "ark_schema_migrations";

export class MigrationRunner {
  constructor(
    private readonly db: IDatabase,
    private readonly dialect: MigrationDialect,
    private readonly migrations: ReadonlyArray<Migration> = MIGRATIONS,
  ) {}

  /**
   * Apply every pending migration up to (and including) `targetVersion`, or
   * up to the latest if no target is given. Idempotent: re-applying is a
   * no-op when the apply log already covers the target.
   */
  apply(opts: MigrationRunOptions = {}): void {
    this.ensureMigrationsTable();
    this.absorbLegacyInstall();
    const current = this.currentVersion();
    const ctx: MigrationApplyContext = { db: this.db, dialect: this.dialect };
    for (const m of this.migrations) {
      if (m.version <= current) continue;
      if (opts.targetVersion !== undefined && m.version > opts.targetVersion) break;
      m.up(ctx);
      this.recordApplied(m);
    }
  }

  /** Read-only summary of applied + pending migrations. */
  status(): MigrationStatus {
    this.ensureMigrationsTable();
    this.absorbLegacyInstall();
    const current = this.currentVersion();
    const applied = this.db
      .prepare(`SELECT version, name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`)
      .all() as Array<{ version: number; name: string; applied_at: string }>;
    const pending = this.migrations
      .filter((m) => m.version > current)
      .map((m) => ({ version: m.version, name: m.name }));
    return { currentVersion: current, pending, applied };
  }

  /**
   * Phase 1 stub. Phase 2 will implement per-migration `down()` callbacks.
   * The interface is here so the CLI can be wired now and the user gets a
   * helpful error instead of "command not found".
   */
  down(_opts: { targetVersion: number }): never {
    throw new Error(
      "Migration rollback is not implemented in Phase 1. Restore from backup, or open an issue if you need this.",
    );
  }

  // -- Internals --------------------------------------------------------

  /** Create the apply log if it doesn't exist. Dialect-aware DDL. */
  private ensureMigrationsTable(): void {
    if (this.dialect === "sqlite") {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
      );
    } else {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL)`,
      );
    }
  }

  /**
   * Existing installs already ran the legacy `initSchema` to completion. If
   * the apply log is empty BUT the canonical legacy table (`compute`) exists,
   * record migration 001 as already-applied so we don't re-execute its body.
   */
  private absorbLegacyInstall(): void {
    if (this.currentVersion() !== 0) return;
    if (!this.tableExists("compute")) return;
    const initial = this.migrations.find((m) => m.version === 1);
    if (!initial) return;
    this.recordApplied(initial);
  }

  private tableExists(name: string): boolean {
    if (this.dialect === "sqlite") {
      const row = this.db
        .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
        .get(name) as { present: number } | undefined;
      return !!row;
    }
    const row = this.db
      .prepare(
        `SELECT 1 AS present FROM information_schema.tables WHERE table_name = $1 AND table_schema = current_schema() LIMIT 1`,
      )
      .get(name) as { present: number } | undefined;
    return !!row;
  }

  private currentVersion(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM ${MIGRATIONS_TABLE}`).get() as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  }

  private recordApplied(m: Migration): void {
    const now = new Date().toISOString();
    if (this.dialect === "sqlite") {
      this.db
        .prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`)
        .run(m.version, m.name, now);
    } else {
      this.db
        .prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
        )
        .run(m.version, m.name, now);
    }
  }
}
