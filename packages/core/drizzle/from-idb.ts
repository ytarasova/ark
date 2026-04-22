/**
 * Lazily build a DrizzleClient from an DatabaseAdapter handle.
 *
 * Used by repositories during the drizzle cutover (Phase B): every repo
 * keeps its existing `constructor(db: DatabaseAdapter)` signature so no caller
 * has to change, but the body now issues typed drizzle queries. This
 * helper extracts the raw driver (bun:sqlite `Database` or postgres.js
 * connection) off the adapter and wraps it in drizzle.
 *
 * The drizzle handle piggy-backs the SAME underlying connection the
 * DatabaseAdapter already owns, so there is no second pool or second SQLite
 * handle. When the DatabaseAdapter is closed, the drizzle handle dies with it.
 *
 * Caches the result on the adapter instance (weak-ref keyed) so repeat
 * lookups inside one repo don't spin up a new drizzle object per call.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { BunSqliteAdapter } from "../database/sqlite.js";
import { PostgresAdapter } from "../database/postgres.js";
import { buildSqliteDrizzle, buildPostgresDrizzle, type DrizzleClient } from "./client.js";

const cache = new WeakMap<object, DrizzleClient>();

export function drizzleFromIDatabase(db: DatabaseAdapter): DrizzleClient {
  const cached = cache.get(db as unknown as object);
  if (cached) return cached;

  let client: DrizzleClient;
  if (db instanceof BunSqliteAdapter) {
    const raw = (db as unknown as { db: unknown }).db;
    client = buildSqliteDrizzle(raw as any);
  } else if (db instanceof PostgresAdapter) {
    client = buildPostgresDrizzle((db as PostgresAdapter).connection);
  } else {
    // Unknown adapter -- caller passed a mock or a future backend. We
    // can't build drizzle without the raw driver, so rethrow a clear
    // error instead of silently failing at query time.
    throw new Error(
      "drizzleFromIDatabase: unsupported DatabaseAdapter implementation " +
        "(expected BunSqliteAdapter or PostgresAdapter). " +
        "Construct the repository with the concrete adapter.",
    );
  }
  cache.set(db as unknown as object, client);
  return client;
}
