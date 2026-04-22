/**
 * Migration 006 -- `api_keys` soft-delete.
 *
 * Adds `deleted_at` + `deleted_by` to `api_keys` and a partial unique index
 * `idx_api_keys_hash_live ON api_keys(key_hash) WHERE deleted_at IS NULL`.
 * The tests exercise the fresh-install path, the upgrade path from a
 * pre-006 DB, and the partial-unique behaviour that distinguishes live
 * from tombstoned rows.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { DatabaseAdapter } from "../../database/types.js";
import { MigrationRunner } from "../runner.js";
import { up as up006 } from "../006_apikeys_soft_delete.js";

async function freshDb(): Promise<DatabaseAdapter> {
  const raw = new Database(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  return new BunSqliteAdapter(raw);
}

async function hasColumn(db: DatabaseAdapter, table: string, column: string): Promise<boolean> {
  const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

async function hasIndex(db: DatabaseAdapter, name: string): Promise<boolean> {
  const row = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)) as
    | { name: string }
    | undefined;
  return !!row;
}

describe("Migration 006 - api_keys soft-delete", () => {
  it("adds deleted_at + deleted_by and creates the partial unique index", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    expect(await hasColumn(db, "api_keys", "deleted_at")).toBe(true);
    expect(await hasColumn(db, "api_keys", "deleted_by")).toBe(true);
    expect(await hasIndex(db, "idx_api_keys_hash_live")).toBe(true);

    const idx = (await db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_api_keys_hash_live'").get()) as
      | { sql: string }
      | undefined;
    expect(idx?.sql).toContain("WHERE deleted_at IS NULL");

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

  it("upgrades a legacy api_keys table (pre-006 shape) by adding columns + index", async () => {
    // Simulate a legacy install: drop the fresh-shape api_keys and
    // recreate it with the pre-006 shape (no deleted_at / deleted_by,
    // no partial unique index), then call 006's up() directly.
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    await db.exec("DROP INDEX IF EXISTS idx_api_keys_hash_live");
    await db.exec("DROP TABLE api_keys");
    await db.exec(
      "CREATE TABLE api_keys (" +
        "id TEXT PRIMARY KEY, " +
        "tenant_id TEXT NOT NULL, " +
        "key_hash TEXT NOT NULL, " +
        "name TEXT NOT NULL, " +
        "role TEXT NOT NULL DEFAULT 'member', " +
        "created_at TEXT NOT NULL, " +
        "last_used_at TEXT, " +
        "expires_at TEXT)",
    );

    const ts = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      )
      .run("ak-legacy", "tenant-a", "hash-legacy", "legacy-key", "admin", ts);

    expect(await hasColumn(db, "api_keys", "deleted_at")).toBe(false);
    expect(await hasIndex(db, "idx_api_keys_hash_live")).toBe(false);

    // Directly re-apply 006 on the legacy shape.
    await up006({ db, dialect: "sqlite" });

    expect(await hasColumn(db, "api_keys", "deleted_at")).toBe(true);
    expect(await hasColumn(db, "api_keys", "deleted_by")).toBe(true);
    expect(await hasIndex(db, "idx_api_keys_hash_live")).toBe(true);

    const row = (await db.prepare("SELECT key_hash, deleted_at FROM api_keys WHERE id = 'ak-legacy'").get()) as
      | { key_hash: string; deleted_at: string | null }
      | undefined;
    expect(row?.key_hash).toBe("hash-legacy");
    expect(row?.deleted_at).toBeNull();

    await db.close();
  });

  it("partial unique index allows re-use of a hash after soft-delete", async () => {
    // The whole point of the partial index: a revoked key's hash must be
    // re-usable by a fresh live key (rotate() depends on this). We assert
    // both directions -- a soft-deleted row with the same hash does NOT
    // block the insert, but two live rows with the same hash DO conflict.
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();

    const ts = new Date().toISOString();
    await db
      .prepare(
        "INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      )
      .run("ak-1", "tenant-a", "dup-hash", "one", "member", ts);

    await db.prepare("UPDATE api_keys SET deleted_at = ? WHERE id = 'ak-1'").run(ts);

    // A fresh live row with the same hash is fine because the dead row
    // is filtered out by the partial index.
    await db
      .prepare(
        "INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
      )
      .run("ak-2", "tenant-a", "dup-hash", "two", "member", ts);

    // But a THIRD live row with the same hash is rejected.
    await expect(
      (async () => {
        await db
          .prepare(
            "INSERT INTO api_keys (id, tenant_id, key_hash, name, role, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)",
          )
          .run("ak-3", "tenant-a", "dup-hash", "three", "member", ts);
      })(),
    ).rejects.toThrow();

    await db.close();
  });
});
