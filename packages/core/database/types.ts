/**
 * Database abstraction layer.
 *
 * IDatabase + IStatement define a minimal interface that both bun:sqlite
 * and future backends (Postgres, etc.) can implement. All repositories
 * and services depend on IDatabase -- never on bun:sqlite directly.
 */

export interface IStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface IDatabase {
  prepare(sql: string): IStatement;
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}
