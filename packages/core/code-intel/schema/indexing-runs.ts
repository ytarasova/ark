/**
 * indexing_runs -- one row per reindex of a (repo, branch, commit).
 *
 * Every other row in the store records the `indexing_run_id` that produced
 * it, so runs can be diffed, rolled back, or explained in a query trace.
 */

export const TABLE = "code_intel_indexing_runs";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      extractor_counts TEXT DEFAULT '{}',
      error_msg TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant_repo ON ${TABLE}(tenant_id, repo_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_status ON ${TABLE}(status);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_started ON ${TABLE}(started_at);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      repo_id UUID NOT NULL,
      branch TEXT NOT NULL,
      commit_sha TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','cancelled')),
      extractor_counts JSONB DEFAULT '{}'::jsonb,
      error_msg TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant_repo ON ${TABLE}(tenant_id, repo_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_status ON ${TABLE}(status);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_started ON ${TABLE}(started_at);
  `;
}
