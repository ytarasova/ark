/**
 * BunSqliteAdapter -- wraps bun:sqlite Database to implement IDatabase.
 *
 * This is the default backend used when running locally. The adapter is
 * intentionally thin: prepare/exec/close delegate directly, and
 * transaction() bridges bun:sqlite's curried API (returns a callable)
 * into the simpler "execute immediately" contract of IDatabase.
 */

import { Database } from "bun:sqlite";
import type { IDatabase, IStatement } from "./database.js";

export class BunSqliteAdapter implements IDatabase {
  constructor(private db: Database) {}

  prepare(sql: string): IStatement {
    return this.db.prepare(sql);
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * bun:sqlite's transaction() returns a wrapped function that you must
   * call to execute. IDatabase.transaction() executes immediately.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
