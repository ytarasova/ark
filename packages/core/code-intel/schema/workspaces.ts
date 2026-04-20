/**
 * workspaces -- the multi-repo grouping that sits between tenants and repos.
 *
 * Hierarchy: `tenant -> workspace -> repo`. A workspace bundles N repos for
 * cross-repo queries, platform docs, access control, and (Wave 2b) session +
 * flow dispatch. `slug` is unique per tenant; `config` is JSON for
 * forward-compatible knobs (default branch policy, retention, etc.).
 *
 * Soft-delete via `deleted_at` mirrors the rest of the schema. Wave 2a does
 * NOT cascade-delete repos when a workspace is soft-deleted; the store
 * refuses to delete a workspace that still has repos attached unless the
 * caller passes `{force: true}` (in which case the repos are detached but
 * not removed).
 */

export const TABLE = "code_intel_workspaces";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_tenant_slug ON ${TABLE}(tenant_id, slug);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      config JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_tenant_slug ON ${TABLE}(tenant_id, slug);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
  `;
}
