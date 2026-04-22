import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/types.js";
import { MigrationRunner } from "../runner.js";

async function freshDb(): Promise<DatabaseAdapter> {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  return new BunSqliteAdapter(raw);
}

async function hasColumn(db: DatabaseAdapter, table: string, column: string): Promise<boolean> {
  const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

async function runSql(db: DatabaseAdapter, sql: string): Promise<void> {
  await db.exec(sql);
}

describe("Migration 004 -- soft-delete", () => {
  it("adds deleted_at to tenants, users, teams, memberships on a fresh DB", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    expect(await hasColumn(db, "tenants", "deleted_at")).toBe(true);
    expect(await hasColumn(db, "users", "deleted_at")).toBe(true);
    expect(await hasColumn(db, "teams", "deleted_at")).toBe(true);
    expect(await hasColumn(db, "memberships", "deleted_at")).toBe(true);

    await db.close();
  });

  it("creates partial unique indexes scoped to live rows", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    const indexes = (await db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE '%_live'")
      .all()) as Array<{ name: string; sql: string }>;

    const names = indexes.map((r) => r.name).sort();
    // Migration 006 adds idx_api_keys_hash_live -- the `%_live` pattern
    // picks it up too, so the full expected set grows by one.
    expect(names).toEqual(
      [
        "idx_api_keys_hash_live",
        "idx_memberships_user_team_live",
        "idx_tenants_slug_live",
        "idx_teams_tenant_slug_live",
        "idx_users_email_live",
      ].sort(),
    );
    for (const r of indexes) {
      expect(r.sql).toContain("WHERE deleted_at IS NULL");
    }

    await db.close();
  });

  it("upgrades a legacy tenants table (no deleted_at) with data preserved", async () => {
    const db = await freshDb();

    // Build up to migration 3, then simulate a legacy install by dropping
    // the new-shape tables and rebuilding them with the pre-004 shape.
    await new MigrationRunner(db, "sqlite").apply({ targetVersion: 3 });

    await runSql(db, "DROP INDEX IF EXISTS idx_tenants_slug_live");
    await runSql(db, "DROP INDEX IF EXISTS idx_users_email_live");
    await runSql(db, "DROP INDEX IF EXISTS idx_teams_tenant_slug_live");
    await runSql(db, "DROP INDEX IF EXISTS idx_memberships_user_team_live");
    await runSql(db, "DROP TABLE memberships");
    await runSql(db, "DROP TABLE teams");
    await runSql(db, "DROP TABLE users");
    await runSql(db, "DROP TABLE tenants");

    const legacyTenants =
      "CREATE TABLE tenants (" +
      "id TEXT PRIMARY KEY, " +
      "slug TEXT NOT NULL UNIQUE, " +
      "name TEXT NOT NULL, " +
      "status TEXT NOT NULL DEFAULT 'active', " +
      "created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL)";
    await runSql(db, legacyTenants);
    const legacyUsers =
      "CREATE TABLE users (" +
      "id TEXT PRIMARY KEY, " +
      "email TEXT NOT NULL UNIQUE, " +
      "name TEXT, " +
      "created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL)";
    await runSql(db, legacyUsers);
    const legacyTeams =
      "CREATE TABLE teams (" +
      "id TEXT PRIMARY KEY, " +
      "tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, " +
      "slug TEXT NOT NULL, " +
      "name TEXT NOT NULL, " +
      "description TEXT, " +
      "created_at TEXT NOT NULL, " +
      "updated_at TEXT NOT NULL, " +
      "UNIQUE (tenant_id, slug))";
    await runSql(db, legacyTeams);
    const legacyMemberships =
      "CREATE TABLE memberships (" +
      "id TEXT PRIMARY KEY, " +
      "user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, " +
      "team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, " +
      "role TEXT NOT NULL DEFAULT 'member', " +
      "created_at TEXT NOT NULL, " +
      "UNIQUE (user_id, team_id))";
    await runSql(db, legacyMemberships);

    const ts = new Date().toISOString();
    await db
      .prepare("INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("t-legacy", "legacy", "Legacy", "active", ts, ts);
    await db
      .prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("u-legacy", "l@example.com", "L", ts, ts);
    await db
      .prepare("INSERT INTO teams (id, tenant_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("tm-legacy", "t-legacy", "eng", "Eng", ts, ts);
    await db
      .prepare("INSERT INTO memberships (id, user_id, team_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("m-legacy", "u-legacy", "tm-legacy", "member", ts);

    // Mark 4 as unapplied so re-applying triggers the rebuild.
    await runSql(db, "DELETE FROM ark_schema_migrations WHERE version = 4");

    await new MigrationRunner(db, "sqlite").apply();

    expect(await hasColumn(db, "tenants", "deleted_at")).toBe(true);
    expect(await hasColumn(db, "users", "deleted_at")).toBe(true);
    expect(await hasColumn(db, "teams", "deleted_at")).toBe(true);
    expect(await hasColumn(db, "memberships", "deleted_at")).toBe(true);

    const tenant = (await db.prepare("SELECT * FROM tenants WHERE id = ?").get("t-legacy")) as
      | { slug: string; deleted_at: string | null }
      | undefined;
    expect(tenant?.slug).toBe("legacy");
    expect(tenant?.deleted_at).toBeNull();

    const user = (await db.prepare("SELECT * FROM users WHERE id = ?").get("u-legacy")) as
      | { email: string }
      | undefined;
    expect(user?.email).toBe("l@example.com");

    const team = (await db.prepare("SELECT * FROM teams WHERE id = ?").get("tm-legacy")) as
      | { slug: string }
      | undefined;
    expect(team?.slug).toBe("eng");

    const mem = (await db.prepare("SELECT * FROM memberships WHERE id = ?").get("m-legacy")) as
      | { role: string }
      | undefined;
    expect(mem?.role).toBe("member");

    await db.close();
  });

  it("partial unique index allows recreating a tenant with the same slug after soft-delete", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();
    const ts = new Date().toISOString();

    await db
      .prepare("INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("t-1", "acme", "Acme", "active", ts, ts);

    await db.prepare("UPDATE tenants SET deleted_at = ? WHERE id = ?").run(ts, "t-1");

    await db
      .prepare("INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("t-2", "acme", "Acme Again", "active", ts, ts);

    const rows = (await db.prepare("SELECT id, slug, deleted_at FROM tenants WHERE slug = 'acme'").all()) as Array<{
      id: string;
      deleted_at: string | null;
    }>;
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.deleted_at === null).length).toBe(1);

    await expect(
      (async () => {
        await db
          .prepare("INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run("t-3", "acme", "Too Many", "active", ts, ts);
      })(),
    ).rejects.toThrow();

    await db.close();
  });

  it("is idempotent -- re-running leaves schema untouched", async () => {
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
});
