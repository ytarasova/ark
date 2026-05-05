/**
 * Postgres half of migration 014 -- workspaces + workspace_repos tables.
 */

import type { DatabaseAdapter } from "../database/index.js";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    config JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_tenant_slug ON workspaces(tenant_id, slug)",
  "CREATE INDEX IF NOT EXISTS idx_workspaces_tenant ON workspaces(tenant_id)",
  `CREATE TABLE IF NOT EXISTS workspace_repos (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    repo_url TEXT NOT NULL,
    name TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    primary_language TEXT,
    local_path TEXT,
    workspace_id UUID,
    config JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL,
    deleted_at TIMESTAMPTZ
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_repos_tenant_url ON workspace_repos(tenant_id, repo_url)",
  "CREATE INDEX IF NOT EXISTS idx_workspace_repos_tenant ON workspace_repos(tenant_id)",
  "CREATE INDEX IF NOT EXISTS idx_workspace_repos_workspace ON workspace_repos(workspace_id)",
];

export async function applyPostgresWorkspaces(db: DatabaseAdapter): Promise<void> {
  const run = db["exec"].bind(db);
  for (const sql of STATEMENTS) {
    await run(sql);
  }
}
