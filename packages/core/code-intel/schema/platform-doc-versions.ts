/**
 * platform_doc_versions -- immutable per-regeneration history of a
 * `platform_docs` row (Wave 2c).
 *
 * Every call to `upsertPlatformDoc` inserts into this table so `ark
 * code-intel docs diff` can compare arbitrary versions long after the
 * corresponding row in `platform_docs` was soft-deleted. `version` is a
 * monotonically-increasing integer per `doc_id`, starting at 1.
 *
 * NOTE: `doc_id` is the *active* row id at time-of-snapshot. Because each
 * regen soft-deletes the previous active row and inserts a fresh one, a
 * given workspace/doc_type has multiple distinct `doc_id` values over time.
 * The version-history surface in the store reconstructs the full timeline
 * keyed on (workspace_id, doc_type) by following `platform_docs` rows
 * (including soft-deleted ones) and folding their `platform_doc_versions`
 * snapshots together.
 */

export const TABLE = "code_intel_platform_doc_versions";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_md TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_doc_version
      ON ${TABLE}(doc_id, version);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_doc ON ${TABLE}(doc_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      doc_id UUID NOT NULL,
      version INTEGER NOT NULL,
      content_md TEXT NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_doc_version
      ON ${TABLE}(doc_id, version);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_doc ON ${TABLE}(doc_id);
  `;
}
