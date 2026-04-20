/**
 * repos -- one row per indexed repository, scoped to a tenant.
 *
 * `repo_url` + `tenant_id` is the natural key. `local_path` is set when the
 * repo is a local working tree; null for remote-only control-plane rows.
 */

export const TABLE = "code_intel_repos";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      name TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      primary_language TEXT,
      local_path TEXT,
      config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_tenant_url ON ${TABLE}(tenant_id, repo_url);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      repo_url TEXT NOT NULL,
      name TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      primary_language TEXT,
      local_path TEXT,
      config JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_tenant_url ON ${TABLE}(tenant_id, repo_url);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
  `;
}
