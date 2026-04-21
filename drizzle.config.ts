/**
 * drizzle-kit configuration -- dialect-split.
 *
 * Usage:
 *   bun run drizzle-kit generate --config drizzle.config.ts            # SQLite (default)
 *   DRIZZLE_DIALECT=postgres bun run drizzle-kit generate              # Postgres
 *   bun run drizzle-kit check  --config drizzle.config.ts              # drift check (wired into `make drift`)
 *
 * The SQLite config emits artifacts under `drizzle/sqlite/`. The Postgres
 * config emits under `drizzle/postgres/`. The Ark MigrationRunner is the
 * execution path; drizzle-kit only owns authoring + drift detection.
 */

import type { Config } from "drizzle-kit";

const dialect = process.env.DRIZZLE_DIALECT ?? "sqlite";

const sqliteConfig: Config = {
  dialect: "sqlite",
  schema: "./packages/core/drizzle/schema/sqlite.ts",
  out: "./drizzle/sqlite",
  // drizzle-kit only needs a URL for `push` / `pull`; `generate` + `check`
  // operate against the schema file alone. Point to the same path the
  // local BunSqliteAdapter uses.
  dbCredentials: { url: process.env.ARK_DB_PATH ?? "./.ark/ark.db" },
  strict: true,
  verbose: true,
};

const postgresConfig: Config = {
  dialect: "postgresql",
  schema: "./packages/core/drizzle/schema/postgres.ts",
  out: "./drizzle/postgres",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://localhost:5432/ark" },
  strict: true,
  verbose: true,
};

export default (dialect === "postgres" ? postgresConfig : sqliteConfig) satisfies Config;
