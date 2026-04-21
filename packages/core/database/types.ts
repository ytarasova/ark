/**
 * Database abstraction layer.
 *
 * IDatabase + IStatement define a minimal interface that both bun:sqlite
 * and future backends (Postgres, etc.) can implement. All repositories
 * and services depend on IDatabase -- never on bun:sqlite directly.
 *
 * The contract is async. bun:sqlite is genuinely synchronous underneath
 * and the BunSqliteAdapter just wraps each call in `Promise.resolve(...)`
 * to satisfy the interface; the real I/O cost is paid by Postgres, where
 * the previous synchronous facade (Bun.sleepSync busy-loop) deadlocked
 * postgres.js promises in EKS. See database/postgres.ts.
 */

export interface IStatement {
  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  get(...params: unknown[]): Promise<unknown | undefined>;
  all(...params: unknown[]): Promise<unknown[]>;
  finalize?(): Promise<void>;
}

export interface IDatabase {
  /**
   * Construct a Statement. Synchronous because bun:sqlite's prepare is
   * cheap and Postgres adapters can defer all I/O until run/get/all.
   */
  prepare(sql: string): IStatement;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
