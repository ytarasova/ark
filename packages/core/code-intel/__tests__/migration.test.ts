import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { MigrationRunner } from "../migration-runner.js";

function newDb() {
  return new BunSqliteAdapter(new Database(":memory:"));
}

describe("MigrationRunner", async () => {
  it("starts at version 0 with two pending migrations", async () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    const status = await runner.status();
    expect(status.currentVersion).toBe(0);
    expect(status.pending.length).toBe(3);
    expect(status.pending[0].version).toBe(1);
    expect(status.pending[1].version).toBe(2);
    expect(status.pending[2].version).toBe(3);
    await db.close();
  });

  it("applies all migrations and bumps the version", async () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    await runner.migrate();
    const status = await runner.status();
    expect(status.currentVersion).toBe(3);
    expect(status.pending.length).toBe(0);
    expect(status.applied.length).toBe(3);
    await db.close();
  });

  it("re-running migrate is idempotent", async () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    await runner.migrate();
    await runner.migrate();
    await runner.migrate();
    const status = await runner.status();
    expect(status.currentVersion).toBe(3);
    expect(status.applied.length).toBe(3);
    await db.close();
  });

  it("seeds the default tenant after migrate", async () => {
    const db = newDb();
    await new MigrationRunner(db, "sqlite").migrate();
    const tenants = (await db.prepare("SELECT * FROM code_intel_tenants")).all() as any[];
    expect(tenants.length).toBe(1);
    expect(tenants[0].slug).toBe("default");
    await db.close();
  });

  it("reset() drops every code_intel_* table", async () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    await runner.migrate();
    await runner.reset();
    const tables = (await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'code_intel_%'")
      .all()) as any[];
    expect(tables.length).toBe(0);
    await db.close();
  });
});
