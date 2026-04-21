/**
 * Drizzle client construction. Returns a dialect-bound handle that repositories
 * can use in place of raw `db.prepare(...).run(...)`.
 *
 * Status (phase A of the drizzle cutover): the handle is exposed via
 * `AppContext.drizzle` for incremental adoption. Repositories still use the
 * hand-rolled SQL path for the moment; see DRIZZLE_CUTOVER_STATUS for the
 * sequencing of the per-repo rewrites.
 *
 * Both drivers reuse the SAME underlying clients the existing `IDatabase`
 * adapters already own:
 *   - SQLite: the `bun:sqlite` `Database` instance
 *   - Postgres: the `postgres.js` client created by `PostgresAdapter`
 * so there is no duplicate connection pool.
 */

import type { Database as BunSqliteDatabase } from "bun:sqlite";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import * as sqliteSchema from "./schema/sqlite.js";
import * as pgSchema from "./schema/postgres.js";

export type DrizzleSqliteClient = ReturnType<typeof drizzleSqlite<typeof sqliteSchema>>;
export type DrizzlePostgresClient = ReturnType<typeof drizzlePostgres<typeof pgSchema>>;

/**
 * Tagged union so callers can branch on dialect when a query genuinely needs
 * to diverge (e.g. `sql\`NOW()\`` vs `sql\`datetime('now')\``). Most code
 * should work against either client transparently via the shared column
 * names defined in the schema modules.
 */
export type DrizzleClient =
  | { dialect: "sqlite"; db: DrizzleSqliteClient; schema: typeof sqliteSchema }
  | { dialect: "postgres"; db: DrizzlePostgresClient; schema: typeof pgSchema };

export function buildSqliteDrizzle(raw: BunSqliteDatabase): DrizzleClient {
  return {
    dialect: "sqlite",
    db: drizzleSqlite(raw, { schema: sqliteSchema }),
    schema: sqliteSchema,
  };
}

export function buildPostgresDrizzle(pg: unknown): DrizzleClient {
  // postgres.js client instance. Typed as `unknown` to avoid leaking the
  // `postgres` type through the public surface; the adapter hands us the
  // exact instance it owns.
  return {
    dialect: "postgres",
    db: drizzlePostgres(pg as any, { schema: pgSchema }),
    schema: pgSchema,
  };
}
