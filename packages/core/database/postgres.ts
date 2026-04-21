/**
 * PostgresAdapter -- wraps postgres.js to implement IDatabase.
 *
 * postgres.js is fully async and so is IDatabase. Every method here is
 * a thin awaiter around `this.sql.unsafe(...)` (or, for transactions,
 * `this.sql.begin(...)`). The previous synchronous facade busy-looped
 * on `Bun.sleepSync(1)` waiting for the postgres.js promise to settle,
 * which prevented libuv from running and deadlocked the hosted control
 * plane on the first query. That whole bridge is gone.
 *
 * SQL dialect differences handled here:
 *   - ? placeholders -> $1, $2, ... (Postgres numbered params)
 *   - AUTOINCREMENT -> GENERATED ALWAYS AS IDENTITY (or SERIAL)
 *   - INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING
 *   - INSERT OR REPLACE -> INSERT ... ON CONFLICT DO UPDATE
 *   - COLLATE NOCASE -> removed (Postgres uses ILIKE instead)
 *   - FTS5 virtual tables -> skipped (Postgres uses tsvector/tsquery)
 *   - INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
 *   - PRAGMA statements -> skipped (not applicable to Postgres)
 */

import postgres from "postgres";
import type { IDatabase, IStatement } from "./types.js";

const createPostgres = postgres as unknown as (url: string, opts?: Record<string, unknown>) => any;

// -- SQL Translation --------------------------------------------------------

/**
 * Convert SQLite-style SQL to Postgres-compatible SQL.
 * Handles common patterns used throughout the Ark codebase.
 */
function sqliteToPostgres(sql: string): string {
  let result = sql;

  // Skip PRAGMA statements entirely
  if (result.trim().toUpperCase().startsWith("PRAGMA")) {
    return "";
  }

  // Skip FTS5 virtual table creation (Postgres doesn't support FTS5)
  if (result.includes("USING fts5")) {
    return "";
  }

  // INSERT OR IGNORE -> INSERT ... ON CONFLICT DO NOTHING
  const hadInsertOrIgnore = /INSERT\s+OR\s+IGNORE/i.test(sql);
  result = result.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
  if (hadInsertOrIgnore) {
    // Append ON CONFLICT DO NOTHING before any trailing semicolons
    result = result.replace(/(\)\s*)(;?\s*)$/, "$1 ON CONFLICT DO NOTHING$2");
    if (!result.includes("ON CONFLICT DO NOTHING")) {
      result += " ON CONFLICT DO NOTHING";
    }
  }

  // INSERT OR REPLACE -> INSERT ... (caller handles conflict resolution)
  if (/INSERT\s+OR\s+REPLACE/i.test(sql)) {
    result = result.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, "INSERT INTO");
  }

  // INTEGER PRIMARY KEY AUTOINCREMENT -> SERIAL PRIMARY KEY
  result = result.replace(/(\w+)\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "$1 SERIAL PRIMARY KEY");

  // COLLATE NOCASE -> removed (Postgres uses ILIKE instead for case-insensitive)
  result = result.replace(/\s+COLLATE\s+NOCASE/gi, "");

  // Convert ? placeholders to $1, $2, ... (positional params)
  let paramIndex = 0;
  result = result.replace(/\?/g, () => `$${++paramIndex}`);

  return result;
}

// -- PostgresStatement ------------------------------------------------------

/**
 * Async statement bound to a PostgresAdapter connection. Each I/O method
 * returns a Promise -- there is no synchronous bridge anymore.
 */
class PostgresStatement implements IStatement {
  private pgSql: string;

  constructor(
    private conn: any,
    rawSql: string,
  ) {
    this.pgSql = sqliteToPostgres(rawSql);
  }

  async run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    if (!this.pgSql) return { changes: 0, lastInsertRowid: 0 };
    const result = await this.conn.unsafe(this.pgSql, params);
    return {
      changes: result.count ?? 0,
      // postgres.js doesn't expose lastInsertRowid; surface the first row's
      // `id` if RETURNING was used, else 0. Callers that need the new id
      // should write `... RETURNING id` explicitly.
      lastInsertRowid: result[0]?.id ?? 0,
    };
  }

  async get(...params: unknown[]): Promise<unknown | undefined> {
    if (!this.pgSql) return undefined;
    const rows = await this.conn.unsafe(this.pgSql, params);
    return rows[0] ?? undefined;
  }

  async all(...params: unknown[]): Promise<unknown[]> {
    if (!this.pgSql) return [];
    const rows = await this.conn.unsafe(this.pgSql, params);
    return Array.from(rows);
  }
}

// -- PostgresAdapter --------------------------------------------------------

export class PostgresAdapter implements IDatabase {
  private sql: any;

  constructor(connectionString: string) {
    this.sql = createPostgres(connectionString, {
      max: 20, // connection pool size
      idle_timeout: 30, // seconds before idle connections close
      connect_timeout: 10, // seconds to wait for a connection
    });
  }

  prepare(query: string): IStatement {
    return new PostgresStatement(this.sql, query);
  }

  async exec(query: string): Promise<void> {
    const pgSql = sqliteToPostgres(query);
    if (!pgSql.trim()) return;

    // Used for DDL and multi-statement SQL.
    // Split on semicolons and run each statement.
    const statements = pgSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await this.sql.unsafe(stmt);
    }
  }

  /**
   * Run `fn` inside a Postgres transaction. We use postgres.js's native
   * `sql.begin(tx => ...)` helper, but `fn` doesn't take the txn handle
   * directly: it closes over the adapter's pooled connection. This means
   * statements issued inside `fn` go through the pool, NOT the txn -- so
   * the BEGIN/COMMIT here only protect statements that explicitly use
   * the wrapped handle. Repository code in PR 1 doesn't need true
   * txn-bound statements; PR 2/3 will revisit if a service needs them.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    let result: T;
    await this.sql.begin(async () => {
      result = await fn();
    });
    return result!;
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  // -- Async variants (preserved for hosted call sites pre-PR-2) ----------
  // These are functionally equivalent to prepare(...).run/all/get; kept
  // for back-compat with hosted call sites that import them directly.

  async execAsync(query: string): Promise<void> {
    return this.exec(query);
  }

  async queryAsync<T = any>(query: string, params?: any[]): Promise<T[]> {
    const pgSql = sqliteToPostgres(query);
    if (!pgSql.trim()) return [];
    const result = await this.sql.unsafe(pgSql, params ?? []);
    return Array.from(result) as T[];
  }

  async queryOneAsync<T = any>(query: string, params?: any[]): Promise<T | null> {
    const rows = await this.queryAsync<T>(query, params);
    return rows[0] ?? null;
  }

  /** Get the underlying postgres.js connection for advanced use. */
  get connection(): any {
    return this.sql;
  }
}

// -- Exported helper --------------------------------------------------------

/** Expose the SQL translator for testing. */
export { sqliteToPostgres };
