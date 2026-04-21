/**
 * MigrationRunner tests -- covers fresh apply, idempotent re-apply,
 * legacy-install absorb, status reporting, and the down stub.
 *
 * Postgres is exercised when `DATABASE_URL` is set; otherwise the
 * Postgres test skips with a one-line log and the SQLite path still runs.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database/index.js";
import { MigrationRunner, MIGRATIONS_TABLE } from "../runner.js";
import type { Migration } from "../types.js";

function freshSqlite(): IDatabase {
  return new BunSqliteAdapter(new Database(":memory:"));
}

describe("MigrationRunner -- sqlite", () => {
  it("applies the registered migrations on a fresh DB", () => {
    const db = freshSqlite();
    const runner = new MigrationRunner(db, "sqlite");
    runner.apply();
    const status = runner.status();
    expect(status.currentVersion).toBeGreaterThanOrEqual(1);
    expect(status.applied.find((a) => a.version === 1)?.name).toBe("initial");
    expect(status.pending.length).toBe(0);
    db.close();
  });

  it("re-running apply() is a no-op", () => {
    const db = freshSqlite();
    const runner = new MigrationRunner(db, "sqlite");
    runner.apply();
    const before = runner.status();
    runner.apply();
    const after = runner.status();
    expect(after.currentVersion).toBe(before.currentVersion);
    expect(after.applied.length).toBe(before.applied.length);
    db.close();
  });

  it("absorbs a legacy install (compute table present, no apply log)", () => {
    const db = freshSqlite();
    // Simulate the pre-migration world: legacy initSchema ran, leaving
    // `compute` behind, but no `ark_schema_migrations`.
    db.exec(`CREATE TABLE compute (name TEXT PRIMARY KEY)`);
    const runner = new MigrationRunner(db, "sqlite");
    const status = runner.status();
    expect(status.currentVersion).toBe(1);
    expect(status.applied[0]?.name).toBe("initial");
    db.close();
  });

  it("respects --to targetVersion", () => {
    const db = freshSqlite();
    let appliedTwo = false;
    const fakeOne: Migration = {
      version: 1,
      name: "one",
      up: (ctx) => ctx.db.exec(`CREATE TABLE one_table (id INTEGER)`),
    };
    const fakeTwo: Migration = {
      version: 2,
      name: "two",
      up: (ctx) => {
        appliedTwo = true;
        ctx.db.exec(`CREATE TABLE two_table (id INTEGER)`);
      },
    };
    const runner = new MigrationRunner(db, "sqlite", [fakeOne, fakeTwo]);
    runner.apply({ targetVersion: 1 });
    expect(appliedTwo).toBe(false);
    expect(runner.status().currentVersion).toBe(1);
    runner.apply();
    expect(appliedTwo).toBe(true);
    expect(runner.status().currentVersion).toBe(2);
    db.close();
  });

  it("creates the apply log table with the documented name", () => {
    const db = freshSqlite();
    new MigrationRunner(db, "sqlite").apply();
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(MIGRATIONS_TABLE) as
      | { name: string }
      | undefined;
    expect(row?.name).toBe(MIGRATIONS_TABLE);
    db.close();
  });

  it("down() throws the Phase 1 stub error", () => {
    const db = freshSqlite();
    const runner = new MigrationRunner(db, "sqlite");
    expect(() => runner.down({ targetVersion: 0 })).toThrow(/not implemented/i);
    db.close();
  });
});

// -- Postgres path -- gated on DATABASE_URL ------------------------------
describe("MigrationRunner -- postgres (gated)", () => {
  const url = process.env.DATABASE_URL;
  const isPg = !!url && (url.startsWith("postgres://") || url.startsWith("postgresql://"));

  if (!isPg) {
    it.skip("DATABASE_URL not set -- skipping Postgres runner tests", () => {});
    return;
  }

  it("applies on a fresh Postgres schema", async () => {
    const { PostgresAdapter } = await import("../../database/postgres.js");
    const db = new PostgresAdapter(url as string);
    const schema = `ark_mig_test_${Date.now()}`;
    db.exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    db.exec(`SET search_path TO ${schema}`);
    try {
      const runner = new MigrationRunner(db, "postgres");
      runner.apply();
      const status = runner.status();
      expect(status.currentVersion).toBeGreaterThanOrEqual(1);
      runner.apply();
      expect(runner.status().currentVersion).toBe(status.currentVersion);
    } finally {
      db.exec(`DROP SCHEMA ${schema} CASCADE`);
      db.close();
    }
  });
});
