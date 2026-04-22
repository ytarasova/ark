/**
 * MigrationRunner -- applies numbered migrations in order.
 *
 * Wave 1 ships one migration (001_initial_schema). Subsequent waves add
 * migrations under `migrations/NNN_<name>.ts`. The runner refuses to skip
 * numbers and refuses to re-apply.
 *
 * The runner is dialect-aware because a single DDL source is emitted per
 * dialect upstream; the migration modules only drive when + which script
 * applies.
 *
 * Every method is async because DatabaseAdapter is async (PR 1 of the async-DB
 * refactor). The body is otherwise unchanged.
 */

import type { DatabaseAdapter } from "../database/index.js";
import * as migration001 from "./migrations/001_initial_schema.js";
import * as migration002 from "./migrations/002_workspaces.js";
import * as migration003 from "./migrations/003_platform_docs.js";
import { TABLE as MIGRATIONS_TABLE } from "./schema/schema-migrations.js";

export interface Migration {
  version: number;
  name: string;
  up(ctx: { db: DatabaseAdapter; dialect: "sqlite" | "postgres" }): Promise<void>;
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  { version: migration001.VERSION, name: migration001.NAME, up: migration001.up },
  { version: migration002.VERSION, name: migration002.NAME, up: migration002.up },
  { version: migration003.VERSION, name: migration003.NAME, up: migration003.up },
];

export interface MigrationRunnerOptions {
  /** When true, stop after applying the named version. */
  targetVersion?: number;
}

export interface MigrationStatus {
  currentVersion: number;
  pending: Migration[];
  applied: Array<{ version: number; name: string; applied_at: string }>;
}

export class MigrationRunner {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly dialect: "sqlite" | "postgres",
  ) {}

  /** Ensure the migrations table exists, then apply any missing versions. */
  async migrate(opts: MigrationRunnerOptions = {}): Promise<void> {
    await this.ensureMigrationsTable();
    const current = await this.currentVersion();
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      if (opts.targetVersion !== undefined && migration.version > opts.targetVersion) break;
      await migration.up({ db: this.db, dialect: this.dialect });
      await this.recordApplied(migration);
    }
  }

  async status(): Promise<MigrationStatus> {
    await this.ensureMigrationsTable();
    const current = await this.currentVersion();
    const applied = (await this.db
      .prepare(`SELECT version, name, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version ASC`)
      .all()) as Array<{ version: number; name: string; applied_at: string }>;
    const pending = MIGRATIONS.filter((m) => m.version > current);
    return { currentVersion: current, pending: [...pending], applied };
  }

  private async ensureMigrationsTable(): Promise<void> {
    // The first migration creates this table, but we must be able to query
    // before applying it.  Emit the same DDL here (idempotent).
    const mod = migration001; // schema_migrations is inside the Wave 1 DDL
    const ddl =
      this.dialect === "sqlite"
        ? `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`
        : `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL);`;
    await this.db.exec(ddl);
    void mod;
  }

  private async currentVersion(): Promise<number> {
    const row = (await this.db.prepare(`SELECT COALESCE(MAX(version), 0) AS v FROM ${MIGRATIONS_TABLE}`).get()) as
      | { v: number | null }
      | undefined;
    return row?.v ?? 0;
  }

  private async recordApplied(m: Migration): Promise<void> {
    const now = new Date().toISOString();
    if (this.dialect === "sqlite") {
      await this.db
        .prepare(`INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`)
        .run(m.version, m.name, now);
    } else {
      await this.db
        .prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (version, name, applied_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        )
        .run(m.version, m.name, now);
    }
  }

  /** Drop every code-intel table. Dev-only; exposed by `ark code-intel db reset`. */
  async reset(): Promise<void> {
    const tables = [
      "code_intel_platform_doc_versions",
      "code_intel_platform_docs",
      "code_intel_file_hotspots",
      "code_intel_contributions",
      "code_intel_people",
      "code_intel_dependencies",
      "code_intel_embeddings",
      "code_intel_external_refs",
      "code_intel_edges",
      "code_intel_chunks_fts",
      "code_intel_chunks",
      "code_intel_symbols",
      "code_intel_files",
      "code_intel_indexing_runs",
      "code_intel_repos",
      "code_intel_workspaces",
      "code_intel_tenants",
      "code_intel_schema_migrations",
    ];
    for (const t of tables) {
      try {
        await this.db.exec(`DROP TABLE IF EXISTS ${t};`);
      } catch {
        // ignore -- FTS virtual tables / views may refuse the DDL depending on adapter.
      }
    }
  }
}
