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
 *
 * Every method is async because IDatabase is async.
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
  async apply(opts: MigrationRunOptions = {}): Promise<void> {
    await this.ensureMigrationsTable();
    await this.absorbLegacyInstall();
    const current = await this.currentVersion();
    const ctx: MigrationApplyContext = { db: this.db, dialect: this.dialect };
    for (const m of this.migrations) {
      if (m.version <= current) continue;
      if (opts.targetVersion !== undefined && m.version > opts.targetVersion) break;
      await m.up(ctx);
      await this.recordApplied(m);
    }
  }

  /** Read-only summary of applied + pending migrations. */
  async status(): Promise<MigrationStatus> {
    await this.ensureMigrationsTable();
    await this.absorbLegacyInstall();
    const current = await this.currentVersion();
    const applied = (await this.db
      .prepare(`SELECT version, name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`)
      .all()) as Array<{ version: number; name: string; applied_at: string }>;
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
  async down(_opts: { targetVersion: number }): Promise<never> {
    throw new Error(
      "Migration rollback is not implemented in Phase 1. Restore from backup, or open an issue if you need this.",
    );
  }

  // -- Internals --------------------------------------------------------

  /** Create the apply log if it doesn't exist. Dialect-aware DDL. */
  private async ensureMigrationsTable(): Promise<void> {
    if (this.dialect === "sqlite") {
      await this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
      );
    } else {
      await this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL)`,
      );
    }
  }

  /**
   * Existing installs already ran the legacy `initSchema` to completion. If
   * the apply log is empty BUT the canonical legacy table (`compute`) exists,
   * record migration 001 as already-applied so we don't re-execute its body.
   */
  private async absorbLegacyInstall(): Promise<void> {
    if ((await this.currentVersion()) !== 0) return;
    if (!(await this.tableExists("compute"))) return;
    const initial = this.migrations.find((m) => m.version === 1);
    if (!initial) return;
    await this.recordApplied(initial);
  }

  private async tableExists(name: string): Promise<boolean> {
    if (this.dialect === "sqlite") {
      const row = (await this.db
        .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
        .get(name)) as { present: number } | undefined;
      return !!row;
    }
    const row = (await this.db
      .prepare(
        `SELECT 1 AS present FROM information_schema.tables WHERE table_name = $1 AND table_schema = current_schema() LIMIT 1`,
      )
      .get(name)) as { present: number } | undefined;
    return !!row;
  }

  private async currentVersion(): Promise<number> {
    const row = (await this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM ${MIGRATIONS_TABLE}`).get()) as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  }

  private async recordApplied(m: Migration): Promise<void> {
    const ts = new Date().toISOString();
    if (this.dialect === "sqlite") {
      await this.db
        .prepare(`INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`)
        .run(m.version, m.name, ts);
    } else {
      await this.db
        .prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES ($1, $2, $3) ON CONFLICT (version) DO NOTHING`,
        )
        .run(m.version, m.name, ts);
    }
  }
}
