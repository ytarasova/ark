/**
 * Migration 002 fresh-apply tests (Wave 2a).
 *
 * Covers:
 *   - Applying 001 then 002 wires the new `workspaces` table, adds
 *     `workspace_id` to `repos`, and seeds a `default` workspace per tenant.
 *   - Existing repos are backfilled to the tenant's default workspace.
 *   - Re-running the migration is idempotent.
 */

import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import { MigrationRunner } from "../migration-runner.js";
import * as migration001 from "../migrations/001_initial_schema.js";
import * as migration002 from "../migrations/002_workspaces.js";
import { TABLE as REPOS_TABLE } from "../schema/repos.js";
import { TABLE as TENANTS_TABLE } from "../schema/tenants.js";
import { TABLE as WORKSPACES_TABLE } from "../schema/workspaces.js";

function newDb() {
  return new BunSqliteAdapter(new Database(":memory:"));
}

describe("Migration 002 (workspaces)", async () => {
  it("applies after 001 and creates the workspaces table + repo column", async () => {
    const db = newDb();
    await new MigrationRunner(db, "sqlite").migrate();
    const tables = (await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'code_intel_%'")
      .all()) as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain(WORKSPACES_TABLE);
    const reposCols = (await db.prepare(`PRAGMA table_info(${REPOS_TABLE})`)).all() as Array<{ name: string }>;
    expect(reposCols.map((c) => c.name)).toContain("workspace_id");
    await db.close();
  });

  it("seeds a default workspace for the default tenant", async () => {
    const db = newDb();
    await new MigrationRunner(db, "sqlite").migrate();
    const rows = (await db
      .prepare(`SELECT slug, tenant_id, name FROM ${WORKSPACES_TABLE} WHERE slug = 'default'`)
      .all()) as Array<{ slug: string; tenant_id: string; name: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].slug).toBe("default");
    await db.close();
  });

  it("backfills pre-existing repos to the tenant's default workspace", async () => {
    const db = newDb();
    // Apply only 001 first, then create a tenant + repo without a workspace,
    // THEN apply 002 so the backfill path is exercised.
    await migration001.up({ db, dialect: "sqlite" });
    // Create a second tenant with repos -- default tenant already exists.
    const altTenantId = "11111111-1111-1111-1111-111111111111";
    await db
      .prepare(`INSERT INTO ${TENANTS_TABLE} (id, name, slug, created_at) VALUES (?, ?, ?, ?)`)
      .run(altTenantId, "Alt", "alt", new Date().toISOString());
    // Two repos each (pre-workspace-column state).
    await db
      .prepare(
        `INSERT INTO ${REPOS_TABLE} (id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at)
         VALUES (?, ?, ?, ?, 'main', NULL, NULL, '{}', ?)`,
      )
      .run("r-def-1", "00000000-0000-0000-0000-000000000001", "file:///d1", "d1", new Date().toISOString());
    await db
      .prepare(
        `INSERT INTO ${REPOS_TABLE} (id, tenant_id, repo_url, name, default_branch, primary_language, local_path, config, created_at)
         VALUES (?, ?, ?, ?, 'main', NULL, NULL, '{}', ?)`,
      )
      .run("r-alt-1", altTenantId, "file:///a1", "a1", new Date().toISOString());

    await migration002.up({ db, dialect: "sqlite" });

    // Every repo now has a workspace_id pointing at the tenant's default workspace.
    const rows = (await db
      .prepare(
        `SELECT r.id, r.tenant_id, r.workspace_id, w.slug FROM ${REPOS_TABLE} r JOIN ${WORKSPACES_TABLE} w ON w.id = r.workspace_id`,
      )
      .all()) as Array<{ id: string; tenant_id: string; workspace_id: string; slug: string }>;
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.slug).toBe("default");
      expect(r.workspace_id).toBeTruthy();
    }
    // Alt tenant got its own default workspace.
    const altWorkspaces = (await db
      .prepare(`SELECT slug FROM ${WORKSPACES_TABLE} WHERE tenant_id = ?`)
      .all(altTenantId)) as Array<{ slug: string }>;
    expect(altWorkspaces.map((w) => w.slug)).toEqual(["default"]);
    await db.close();
  });

  it("re-running the migration is idempotent (no duplicate workspaces, no column errors)", async () => {
    const db = newDb();
    const runner = new MigrationRunner(db, "sqlite");
    await runner.migrate();
    await runner.migrate();
    await runner.migrate();
    const status = await runner.status();
    expect(status.currentVersion).toBe(3);
    expect(status.applied.length).toBe(3);
    const count = (await db.prepare(`SELECT COUNT(*) AS n FROM ${WORKSPACES_TABLE}`)).get() as { n: number };
    expect(count.n).toBe(1);
    await db.close();
  });
});
