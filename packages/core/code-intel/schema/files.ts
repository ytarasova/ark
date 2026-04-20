/**
 * files -- first-class file records.
 *
 * (tenant_id, repo_id, path, sha) is the natural key so multiple commits
 * of the same file can coexist. `mtime` + `size_bytes` are useful for
 * incremental extractor short-circuits. `deleted_at` soft-deletes so
 * concurrent queries never see a torn state during reindex.
 */

export const TABLE = "code_intel_files";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      path TEXT NOT NULL,
      sha TEXT NOT NULL,
      mtime TEXT,
      language TEXT,
      size_bytes INTEGER,
      indexing_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_unique ON ${TABLE}(tenant_id, repo_id, path, sha);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_repo ON ${TABLE}(tenant_id, repo_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_path ON ${TABLE}(path);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_lang ON ${TABLE}(language);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_run ON ${TABLE}(indexing_run_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      repo_id UUID NOT NULL,
      path TEXT NOT NULL,
      sha TEXT NOT NULL,
      mtime TIMESTAMPTZ,
      language TEXT,
      size_bytes BIGINT,
      indexing_run_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_unique ON ${TABLE}(tenant_id, repo_id, path, sha);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_repo ON ${TABLE}(tenant_id, repo_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_path ON ${TABLE}(path);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_lang ON ${TABLE}(language);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_run ON ${TABLE}(indexing_run_id);
  `;
}
