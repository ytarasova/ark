/**
 * dependencies -- dependency-manifest entries (npm, pip, maven, ...).
 *
 * `manifest_kind` is an open enum; production-tier list is pulled from syft
 * output. `dep_type` separates prod / dev / peer / optional. Constraint keeps
 * reindexes idempotent.
 */

export const TABLE = "code_intel_dependencies";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      file_id TEXT,
      manifest_kind TEXT NOT NULL,
      name TEXT NOT NULL,
      version_constraint TEXT,
      resolved_version TEXT,
      dep_type TEXT NOT NULL DEFAULT 'prod',
      indexing_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_unique
      ON ${TABLE}(tenant_id, repo_id, manifest_kind, name, dep_type);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_name ON ${TABLE}(name);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_repo ON ${TABLE}(tenant_id, repo_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      repo_id UUID NOT NULL,
      file_id UUID,
      manifest_kind TEXT NOT NULL
        CHECK (manifest_kind IN ('npm','pip','maven','gradle','cargo','go','gem','composer','nuget','other')),
      name TEXT NOT NULL,
      version_constraint TEXT,
      resolved_version TEXT,
      dep_type TEXT NOT NULL DEFAULT 'prod'
        CHECK (dep_type IN ('prod','dev','peer','optional')),
      indexing_run_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_unique
      ON ${TABLE}(tenant_id, repo_id, manifest_kind, name, dep_type);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_name ON ${TABLE}(name);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_repo ON ${TABLE}(tenant_id, repo_id);
  `;
}
