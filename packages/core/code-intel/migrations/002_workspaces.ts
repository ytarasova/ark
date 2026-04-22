/**
 * Migration 002 -- workspaces foundation (Wave 2a).
 *
 *   1. Create the `code_intel_workspaces` table.
 *   2. Add `workspace_id` column to `code_intel_repos` (nullable; backfilled).
 *   3. Seed one `default` workspace per existing tenant.
 *   4. Backfill every existing repo to its tenant's default workspace.
 *
 * Idempotent: each step probes for prior state before mutating, so re-running
 * the migration on a partially-applied DB is safe. The migration runner also
 * gates by `schema_migrations.version`, so the normal path runs each step
 * exactly once.
 */

import type { DatabaseAdapter } from "../../database/index.js";
import { randomUUID } from "crypto";
import * as workspacesSchema from "../schema/workspaces.js";
import { TABLE as WORKSPACES_TABLE } from "../schema/workspaces.js";
import { TABLE as REPOS_TABLE } from "../schema/repos.js";
import { TABLE as TENANTS_TABLE } from "../schema/tenants.js";

export const VERSION = 2;
export const NAME = "workspaces";

export interface MigrationApplyContext {
  db: DatabaseAdapter;
  dialect: "sqlite" | "postgres";
}

export async function up(ctx: MigrationApplyContext): Promise<void> {
  // 1. Create the workspaces table (DDL is idempotent on its own).
  const ddl = ctx.dialect === "sqlite" ? workspacesSchema.sqliteDDL() : workspacesSchema.postgresDDL();
  await ctx.db.exec(ddl);

  // 2. Add workspace_id to repos if not already present.
  if (!(await hasColumn(ctx, REPOS_TABLE, "workspace_id"))) {
    if (ctx.dialect === "sqlite") {
      await ctx.db.exec(`ALTER TABLE ${REPOS_TABLE} ADD COLUMN workspace_id TEXT`);
    } else {
      await ctx.db.exec(`ALTER TABLE ${REPOS_TABLE} ADD COLUMN workspace_id UUID`);
    }
    await ctx.db.exec(`CREATE INDEX IF NOT EXISTS idx_${REPOS_TABLE}_workspace ON ${REPOS_TABLE}(workspace_id)`);
  }

  // 3 + 4. Per tenant, ensure a `default` workspace exists, then attach orphan repos.
  const tenants = (await ctx.db.prepare(`SELECT id FROM ${TENANTS_TABLE}`).all()) as Array<{ id: string }>;
  const now = new Date().toISOString();
  for (const t of tenants) {
    const existing = (await ctx.db
      .prepare(
        ctx.dialect === "sqlite"
          ? `SELECT id FROM ${WORKSPACES_TABLE} WHERE tenant_id = ? AND slug = ?`
          : `SELECT id FROM ${WORKSPACES_TABLE} WHERE tenant_id = $1 AND slug = $2`,
      )
      .get(t.id, "default")) as { id: string } | undefined;

    let workspaceId = existing?.id;
    if (!workspaceId) {
      workspaceId = randomUUID();
      if (ctx.dialect === "sqlite") {
        await ctx.db
          .prepare(
            `INSERT INTO ${WORKSPACES_TABLE} (id, tenant_id, slug, name, description, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(workspaceId, t.id, "default", "Default", "Auto-created default workspace", "{}", now);
      } else {
        await ctx.db
          .prepare(
            `INSERT INTO ${WORKSPACES_TABLE} (id, tenant_id, slug, name, description, config, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) ON CONFLICT (tenant_id, slug) DO NOTHING`,
          )
          .run(workspaceId, t.id, "default", "Default", "Auto-created default workspace", "{}", now);
      }
    }

    // Backfill orphan repos belonging to this tenant.
    if (ctx.dialect === "sqlite") {
      await ctx.db
        .prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = ? WHERE tenant_id = ? AND workspace_id IS NULL`)
        .run(workspaceId, t.id);
    } else {
      await ctx.db
        .prepare(`UPDATE ${REPOS_TABLE} SET workspace_id = $1 WHERE tenant_id = $2 AND workspace_id IS NULL`)
        .run(workspaceId, t.id);
    }
  }
}

/** Probe whether a table already has a given column. Dialect-aware. */
async function hasColumn(ctx: MigrationApplyContext, table: string, column: string): Promise<boolean> {
  if (ctx.dialect === "sqlite") {
    const rows = (await ctx.db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
    return rows.some((r) => r.name === column);
  }
  const row = (await ctx.db
    .prepare(`SELECT 1 AS present FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1`)
    .get(table, column)) as { present: number } | undefined;
  return !!row;
}
