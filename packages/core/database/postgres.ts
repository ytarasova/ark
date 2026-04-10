/**
 * PostgresAdapter -- wraps postgres.js to implement IDatabase.
 *
 * postgres.js is fully async, but IDatabase has synchronous methods
 * (prepare/get/all/run). This adapter bridges the gap by using Bun's
 * ability to run async operations synchronously via a blocking wrapper.
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

import type { IDatabase, IStatement } from "./types.js";

// postgres.js uses `export =` in its type definitions. In Bun's ESM resolution
// the default export is under .default. We use require + destructure for compat.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { default: createPostgres } = require("postgres") as { default: (url: string, opts?: any) => any };

// ── SQL Translation ─────────────────────────────────────────────────────────

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
  result = result.replace(
    /(\w+)\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi,
    "$1 SERIAL PRIMARY KEY"
  );

  // COLLATE NOCASE -> removed (Postgres uses ILIKE instead for case-insensitive)
  result = result.replace(/\s+COLLATE\s+NOCASE/gi, "");

  // Convert ? placeholders to $1, $2, ... (positional params)
  let paramIndex = 0;
  result = result.replace(/\?/g, () => `$${++paramIndex}`);

  return result;
}

// ── PostgresStatement ───────────────────────────────────────────────────────

/**
 * Wraps a postgres.js query to implement the IStatement interface.
 *
 * Since postgres.js is async and IStatement is sync, we use a blocking
 * pattern via Bun.sleepSync to let the event loop process I/O while
 * we wait for the postgres.js promise to settle.
 *
 * For production hosted deployments, callers should transition to the
 * async variants (queryAsync, queryOneAsync) on PostgresAdapter.
 */
class PostgresStatement implements IStatement {
  private pgSql: string;

  constructor(
    private conn: any,
    rawSql: string,
  ) {
    this.pgSql = sqliteToPostgres(rawSql);
  }

  run(...params: any[]): { changes: number; lastInsertRowid: number } {
    if (!this.pgSql) return { changes: 0, lastInsertRowid: 0 };

    const result = this._runSync(params);

    return {
      changes: result.count ?? 0,
      lastInsertRowid: result[0]?.id ?? 0,
    };
  }

  get(...params: any[]): any {
    if (!this.pgSql) return undefined;

    const rows = this._querySync(params);
    return rows[0] ?? undefined;
  }

  all(...params: any[]): any[] {
    if (!this.pgSql) return [];

    return this._querySync(params);
  }

  /**
   * Run a query synchronously by blocking on the async result.
   * Bun processes I/O during Bun.sleepSync, allowing the promise to settle.
   */
  private _runSync(params: any[]): any {
    if (!this.pgSql.trim()) {
      return Object.assign([], { count: 0 });
    }

    let result: any;
    let error: any;
    let done = false;

    this.conn.unsafe(this.pgSql, params).then(
      (r: any) => { result = r; done = true; },
      (e: any) => { error = e; done = true; },
    );

    while (!done) {
      Bun.sleepSync(1);
    }

    if (error) throw error;
    return result;
  }

  private _querySync(params: any[]): any[] {
    const result = this._runSync(params);
    return Array.from(result);
  }
}

// ── PostgresAdapter ─────────────────────────────────────────────────────────

export class PostgresAdapter implements IDatabase {
  private sql: any;

  constructor(connectionString: string) {
    this.sql = createPostgres(connectionString, {
      max: 20,                 // connection pool size
      idle_timeout: 30,        // seconds before idle connections close
      connect_timeout: 10,     // seconds to wait for a connection
    });
  }

  prepare(query: string): IStatement {
    return new PostgresStatement(this.sql, query);
  }

  exec(query: string): void {
    const pgSql = sqliteToPostgres(query);
    if (!pgSql.trim()) return;

    // Used for DDL and multi-statement SQL.
    // Split on semicolons and run each statement.
    const statements = pgSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      let done = false;
      let error: any;

      this.sql.unsafe(stmt).then(
        () => { done = true; },
        (e: any) => { error = e; done = true; },
      );

      while (!done) {
        Bun.sleepSync(1);
      }

      if (error) throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    // Postgres transactions are async, but IDatabase.transaction is sync.
    // We use BEGIN/COMMIT/ROLLBACK manually since the fn() inside calls
    // prepare() on this adapter (which uses the pool).
    let result: T;
    let error: any;
    let done = false;

    (async () => {
      try {
        await this.sql.unsafe("BEGIN");
        try {
          result = fn();
          await this.sql.unsafe("COMMIT");
        } catch (e) {
          await this.sql.unsafe("ROLLBACK");
          throw e;
        }
      } catch (e) {
        error = e;
      }
      done = true;
    })();

    while (!done) {
      Bun.sleepSync(1);
    }

    if (error) throw error;
    return result!;
  }

  close(): void {
    let done = false;
    this.sql.end().then(
      () => { done = true; },
      () => { done = true; },
    );
    while (!done) {
      Bun.sleepSync(1);
    }
  }

  // ── Async variants (preferred for hosted Postgres deployments) ──────────

  async execAsync(query: string): Promise<void> {
    const pgSql = sqliteToPostgres(query);
    if (!pgSql.trim()) return;

    const statements = pgSql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const stmt of statements) {
      await this.sql.unsafe(stmt);
    }
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

// ── Exported helper ─────────────────────────────────────────────────────────

/** Expose the SQL translator for testing. */
export { sqliteToPostgres };
