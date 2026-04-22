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
 * Every method is async because DatabaseAdapter is async.
 */

import type { DatabaseAdapter } from "../database/index.js";
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
    private readonly db: DatabaseAdapter,
    private readonly dialect: MigrationDialect,
    private readonly migrations: ReadonlyArray<Migration> = MIGRATIONS,
  ) {}

  /**
   * Apply every pending migration up to (and including) `targetVersion`, or
   * up to the latest if no target is given. Idempotent: re-applying is a
   * no-op when the apply log already covers the target.
   */
  async apply(opts: MigrationRunOptions = {}): Promise<void> {
    // Postgres boot: take a session-level advisory lock so two instances
    // colliding at startup don't double-apply the same migration. The lock
    // key is a stable hash of a fixed string so every instance agrees. The
    // lock is released in a `finally` — even if a migration throws, another
    // booting instance must be able to retry after we exit.
    //
    // SQLite doesn't need this because bun:sqlite is process-local: the only
    // concurrent writers are inside one process, already serialized by the
    // apply loop below.
    const released = await this.acquireAdvisoryLock();
    try {
      await this.ensureMigrationsTable();
      await this.absorbLegacyInstall();
      const current = await this.currentVersion();
      const ctx: MigrationApplyContext = { db: this.db, dialect: this.dialect };
      for (const m of this.migrations) {
        if (m.version <= current) continue;
        if (opts.targetVersion !== undefined && m.version > opts.targetVersion) break;
        await this.applyOne(m, ctx);
      }
    } finally {
      await released();
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

  /**
   * Apply a single migration inside a transaction wrap.
   *
   * Wrapping `up()` + `recordApplied()` together means a crash mid-migration
   * can never leave the apply log out of sync with the actual DDL state --
   * either both land or neither does.
   *
   * SQLite quirk: migration 004_soft_delete toggles `PRAGMA foreign_keys =
   * OFF` around a table rebuild because DROP TABLE would otherwise cascade
   * to dependent rows. `PRAGMA foreign_keys` is a no-op inside an open
   * transaction, so we toggle it OUTSIDE the BEGIN/COMMIT window for the
   * SQLite path. Postgres doesn't need this -- its FK checks can be deferred
   * with `SET CONSTRAINTS ALL DEFERRED` inside the txn if a future migration
   * needs it.
   */
  private async applyOne(m: Migration, ctx: MigrationApplyContext): Promise<void> {
    const sqliteDialect = this.dialect === "sqlite";
    if (sqliteDialect) {
      await this.db.exec("PRAGMA foreign_keys = OFF");
    }
    try {
      await this.db.transaction(async () => {
        await m.up(ctx);
        await this.recordApplied(m);
      });
    } finally {
      if (sqliteDialect) {
        await this.db.exec("PRAGMA foreign_keys = ON");
      }
    }
  }

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

  /**
   * Postgres session-level advisory lock held across the entire `apply()`
   * loop. On SQLite this is a no-op — bun:sqlite is process-local, so the
   * only concurrent writers are inside one process and already serialized.
   *
   * Returns a `release()` function callers MUST invoke in a `finally`. The
   * lock uses the constant key `hashtext('ark_migrations')` so every Ark
   * instance in the same Postgres DB agrees on the lock identity.
   */
  private async acquireAdvisoryLock(): Promise<() => Promise<void>> {
    if (this.dialect !== "postgres") {
      return async () => {};
    }
    await this.db.prepare(`SELECT pg_advisory_lock(hashtext('ark_migrations'))`).run();
    return async () => {
      try {
        await this.db.prepare(`SELECT pg_advisory_unlock(hashtext('ark_migrations'))`).run();
      } catch {
        // Unlock can fail if the connection was already reset; the lock is
        // session-scoped so Postgres will reclaim it on disconnect anyway.
      }
    };
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
