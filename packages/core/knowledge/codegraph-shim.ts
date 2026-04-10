/**
 * bun:sqlite shim for @optave/codegraph.
 *
 * ops-codegraph uses better-sqlite3 for queries, which Bun doesn't support.
 * This module provides a compatibility wrapper using bun:sqlite.
 *
 * The native Rust engine (buildGraph) works fine on Bun -- only the
 * JS-side query layer needs this shim.
 */

import { Database as BunDatabase } from "bun:sqlite";

/**
 * Wrap bun:sqlite Database to match better-sqlite3's API surface.
 *
 * Key differences handled:
 * - better-sqlite3 has .pragma("key = value"), bun:sqlite uses .run("PRAGMA ...")
 * - better-sqlite3 .prepare().pluck() returns scalars
 * - better-sqlite3 .transaction() returns a wrapped function
 */
class BunSqliteShim {
  _db: InstanceType<typeof BunDatabase>;

  constructor(pathOrBuf: string, opts?: { readonly?: boolean }) {
    const readonly = opts?.readonly ?? false;
    this._db = new BunDatabase(pathOrBuf, { readonly });
  }

  pragma(str: string): any {
    const trimmed = str.trim();
    if (trimmed.includes("=")) {
      this._db.run(`PRAGMA ${trimmed}`);
      return;
    }
    return this._db.query(`PRAGMA ${trimmed}`).get();
  }

  prepare(sql: string) {
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) { return stmt.run(...params); },
      get(...params: any[]) { return stmt.get(...params); },
      all(...params: any[]) { return stmt.all(...params); },
      pluck(_flag = true) {
        return {
          get(...p: any[]) {
            const r = stmt.get(...p);
            return r ? Object.values(r)[0] : undefined;
          },
          all(...p: any[]) {
            return stmt.all(...p).map((r: any) => Object.values(r)[0]);
          },
        };
      },
      bind(..._params: any[]) { return stmt; },
      [Symbol.iterator](...params: any[]) {
        return stmt.all(...params)[Symbol.iterator]();
      },
    };
  }

  run(sql: string): void { this._db.run(sql); }

  transaction(fn: (...args: any[]) => any) {
    return (...args: any[]) => {
      this._db.run("BEGIN");
      try {
        const result = fn(...args);
        this._db.run("COMMIT");
        return result;
      } catch (e) {
        this._db.run("ROLLBACK");
        throw e;
      }
    };
  }

  close(): void { this._db.close(); }

  get open(): boolean { return true; }
}

/**
 * Open a codegraph database directly with bun:sqlite.
 * Use for querying a .codegraph/graph.db built by the native Rust engine.
 */
export function openCodegraphDb(dbPath: string, readonly = true): InstanceType<typeof BunDatabase> {
  return new BunDatabase(dbPath, { readonly });
}

/**
 * Get the BunSqliteShim class for use as a better-sqlite3 replacement.
 */
export function getBunSqliteShim(): new (...args: any[]) => any {
  return BunSqliteShim as any;
}
