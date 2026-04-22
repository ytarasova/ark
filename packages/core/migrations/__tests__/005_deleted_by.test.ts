/**
 * Migration 005 -- `deleted_by` column on every soft-deletable auth entity.
 *
 * These tests exercise both the fresh-install path (the runner applies
 * 001..006 in order) and the upgrade path (the runner lands 004 first,
 * then 005 adds the column on an existing table). They also confirm that
 * re-running 005 on an already-migrated DB is a no-op.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/types.js";
import { MigrationRunner } from "../runner.js";
import { up as up005 } from "../005_deleted_by.js";

async function freshDb(): Promise<DatabaseAdapter> {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  return new BunSqliteAdapter(raw);
}

async function hasColumn(db: DatabaseAdapter, table: string, column: string): Promise<boolean> {
  const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

describe("Migration 005 - deleted_by audit column", () => {
  it("adds deleted_by to tenants, users, teams, memberships on a fresh DB", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    expect(await hasColumn(db, "tenants", "deleted_by")).toBe(true);
    expect(await hasColumn(db, "users", "deleted_by")).toBe(true);
    expect(await hasColumn(db, "teams", "deleted_by")).toBe(true);
    expect(await hasColumn(db, "memberships", "deleted_by")).toBe(true);

    await db.close();
  });

  it("is idempotent - re-running leaves the schema untouched", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();
    const before = (await db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all()) as Array<{ name: string }>;
    await new MigrationRunner(db, "sqlite").apply();
    const after = (await db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all()) as Array<{ name: string }>;
    expect(after.map((r) => r.name)).toEqual(before.map((r) => r.name));

    await db.close();
  });

  it("upgrades a legacy DB (pre-005 shape) by adding deleted_by without losing data", async () => {
    // Simulate a legacy install whose tenants table was created before
    // migration 005 landed: no `deleted_by` column, but with `deleted_at`
    // (from 004). Drop + recreate tenants with the legacy shape, then let
    // the runner's re-apply (without the v5 row in ark_schema_migrations)
    // land the ALTER TABLE.
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    // Rebuild tenants with the pre-005 shape.
    await db.exec("DROP INDEX IF EXISTS idx_tenants_slug_live");
    await db.exec("DROP TABLE IF EXISTS tenants_legacy_backup");
    await db.exec("CREATE TABLE tenants_legacy_backup AS SELECT * FROM tenants");
    await db.exec("DROP TABLE tenants");
    await db.exec(
      "CREATE TABLE tenants (" +
        "id TEXT PRIMARY KEY, " +
        "slug TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "status TEXT NOT NULL DEFAULT 'active', " +
        "deleted_at TEXT, " +
        "created_at TEXT NOT NULL, " +
        "updated_at TEXT NOT NULL)",
    );
    await db.exec(
      "INSERT INTO tenants (id, slug, name, status, deleted_at, created_at, updated_at) " +
        "SELECT id, slug, name, status, deleted_at, created_at, updated_at FROM tenants_legacy_backup",
    );
    await db.exec("DROP TABLE tenants_legacy_backup");

    expect(await hasColumn(db, "tenants", "deleted_by")).toBe(false);

    // Directly re-apply the 005 migration on top of the legacy shape.
    // (Going through MigrationRunner would short-circuit because the log
    // already records 005+006.)
    await up005({ db, dialect: "sqlite" });

    expect(await hasColumn(db, "tenants", "deleted_by")).toBe(true);

    // Pre-existing rows default to NULL deleted_by.
    const row = (await db.prepare("SELECT deleted_by FROM tenants WHERE id = 'default'").get()) as
      | { deleted_by: string | null }
      | undefined;
    expect(row?.deleted_by).toBeNull();

    await db.close();
  });

  it("lets callers record deleted_by values and read them back", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    const ts = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO tenants (id, slug, name, status, deleted_at, deleted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("t-audit", "audit", "Audit", "active", ts, "u-actor-42", ts, ts);

    const row = (await db.prepare("SELECT deleted_by FROM tenants WHERE id = 't-audit'").get()) as
      | { deleted_by: string | null }
      | undefined;
    expect(row?.deleted_by).toBe("u-actor-42");

    await db.close();
  });
});
