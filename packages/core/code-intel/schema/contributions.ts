/**
 * contributions -- aggregated per-(person, repo, file) activity.
 *
 * One row per contributor per file (file_id null = repo-level roll-up).
 * Recomputed per indexing run; previous runs soft-deleted. `first_commit`
 * / `last_commit` support "who wrote this originally" and "who last
 * touched this" queries.
 */

export const TABLE = "code_intel_contributions";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      file_id TEXT,
      commit_count INTEGER NOT NULL DEFAULT 0,
      loc_added INTEGER NOT NULL DEFAULT 0,
      loc_removed INTEGER NOT NULL DEFAULT 0,
      first_commit TEXT,
      last_commit TEXT,
      indexing_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_person ON ${TABLE}(person_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_repo ON ${TABLE}(tenant_id, repo_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_file ON ${TABLE}(file_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      person_id UUID NOT NULL,
      repo_id UUID NOT NULL,
      file_id UUID,
      commit_count INTEGER NOT NULL DEFAULT 0,
      loc_added INTEGER NOT NULL DEFAULT 0,
      loc_removed INTEGER NOT NULL DEFAULT 0,
      first_commit TIMESTAMPTZ,
      last_commit TIMESTAMPTZ,
      indexing_run_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_person ON ${TABLE}(person_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_repo ON ${TABLE}(tenant_id, repo_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_file ON ${TABLE}(file_id);
  `;
}
