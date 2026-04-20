import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { MigrationRunner } from "../migration-runner.js";

function newDb() {
  return new BunSqliteAdapter(new Database(":memory:"));
}

describe("MigrationRunner", () => {
  it("starts at version 0 with one pending migration", () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    const status = runner.status();
    expect(status.currentVersion).toBe(0);
    expect(status.pending.length).toBe(1);
    expect(status.pending[0].version).toBe(1);
    db.close();
  });

  it("applies the initial migration and bumps the version", () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    runner.migrate();
    const status = runner.status();
    expect(status.currentVersion).toBe(1);
    expect(status.pending.length).toBe(0);
    expect(status.applied.length).toBe(1);
    db.close();
  });

  it("re-running migrate is idempotent", () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    runner.migrate();
    runner.migrate();
    runner.migrate();
    const status = runner.status();
    expect(status.currentVersion).toBe(1);
    expect(status.applied.length).toBe(1);
    db.close();
  });

  it("seeds the default tenant after migrate", () => {
    const db = newDb();
    new MigrationRunner(db, "sqlite").migrate();
    const tenants = db.prepare("SELECT * FROM code_intel_tenants").all() as any[];
    expect(tenants.length).toBe(1);
    expect(tenants[0].slug).toBe("default");
    db.close();
  });

  it("reset() drops every code_intel_* table", () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    runner.migrate();
    runner.reset();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'code_intel_%'")
      .all() as any[];
    expect(tables.length).toBe(0);
    db.close();
  });
});
