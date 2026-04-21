/**
 * Migration 008 -- tenant_policies.compute_config_yaml column.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database/types.js";
import { MigrationRunner } from "../runner.js";
import { up as up008, VERSION as V008 } from "../008_tenant_compute_config.js";

async function freshDb(): Promise<IDatabase> {
  return new BunSqliteAdapter(new Database(":memory:"));
}

async function hasColumn(db: IDatabase, table: string, column: string): Promise<boolean> {
  const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

describe("Migration 008 -- tenant_compute_config", () => {
  it("adds compute_config_yaml to tenant_policies on a fresh install", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();
    expect(await hasColumn(db, "tenant_policies", "compute_config_yaml")).toBe(true);
    await db.close();
  });

  it("is idempotent -- re-running does nothing destructive", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();
    const blobYaml = "- name: x\n  kind: k8s\n  apiEndpoint: https://x.example.com\n  auth:\n    kind: in_cluster\n";
    await db
      .prepare(
        `INSERT INTO tenant_policies (tenant_id, compute_config_yaml, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("acme", blobYaml, new Date().toISOString(), new Date().toISOString());

    await up008({ db, dialect: "sqlite" });

    const row = (await db
      .prepare("SELECT compute_config_yaml FROM tenant_policies WHERE tenant_id = 'acme'")
      .get()) as { compute_config_yaml: string };
    expect(row.compute_config_yaml).toContain("name: x");
    await db.close();
  });

  it("short-circuits when apply log already records version >= 8", async () => {
    const db = await freshDb();
    await new MigrationRunner(db, "sqlite").apply();
    expect(V008).toBe(8);
    await expect(up008({ db, dialect: "sqlite" })).resolves.toBeUndefined();
    await db.close();
  });

  it("creates the parent tenant_policies table if it is missing", async () => {
    const db = await freshDb();
    await db.exec(
      `CREATE TABLE IF NOT EXISTS ark_schema_migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)`,
    );
    await up008({ db, dialect: "sqlite" });
    expect(await hasColumn(db, "tenant_policies", "compute_config_yaml")).toBe(true);
    await db.close();
  });
});
