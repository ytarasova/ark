/**
 * BunSqliteAdapter -- wraps bun:sqlite Database to implement DatabaseAdapter.
 *
 * This is the default backend used when running locally. bun:sqlite is
 * genuinely synchronous; the adapter wraps each I/O call in a resolved
 * Promise to satisfy the async DatabaseAdapter contract. There is no event-loop
 * cost here -- the underlying call has already completed by the time
 * Promise.resolve() returns.
 *
 * `transaction(fn)` cannot use bun:sqlite's native `db.transaction(fn)`
 * because that helper requires a synchronous fn; our contract takes an
 * async fn so callers can await DatabaseAdapter ops inside the transaction.
 * We open BEGIN/COMMIT manually instead.
 */

import { Database, type Statement as BunStatement } from "bun:sqlite";
import type { DatabaseAdapter, PreparedStatement } from "./types.js";

class BunSqliteStatement implements PreparedStatement {
  constructor(private stmt: BunStatement) {}

  run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const result = this.stmt.run(...(params as Parameters<BunStatement["run"]>));
    return Promise.resolve({
      changes: result.changes,
      lastInsertRowid: result.lastInsertRowid,
    });
  }

  get(...params: unknown[]): Promise<unknown | undefined> {
    return Promise.resolve(this.stmt.get(...(params as Parameters<BunStatement["get"]>)) ?? undefined);
  }

  all(...params: unknown[]): Promise<unknown[]> {
    return Promise.resolve(this.stmt.all(...(params as Parameters<BunStatement["all"]>)));
  }

  finalize(): Promise<void> {
    this.stmt.finalize();
    return Promise.resolve();
  }
}

export class BunSqliteAdapter implements DatabaseAdapter {
  constructor(private db: Database) {}

  prepare(sql: string): PreparedStatement {
    return new BunSqliteStatement(this.db.prepare(sql));
  }

  exec(sql: string): Promise<void> {
    this.db.exec(sql);
    return Promise.resolve();
  }

  /**
   * Open a transaction and run `fn` inside it. The fn is async because
   * DatabaseAdapter ops are async; we BEGIN, await fn(), then COMMIT (or
   * ROLLBACK on throw). bun:sqlite's native `db.transaction(fn)` helper
   * doesn't accept async functions, so we drive the lifecycle manually.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Rollback may fail if the txn was already aborted (e.g. by the
        // underlying error). Surface the original error in that case.
      }
      throw err;
    }
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
