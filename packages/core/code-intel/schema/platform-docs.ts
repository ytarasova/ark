/**
 * platform_docs -- derived, cross-repo synthesis documents scoped to a
 * workspace (Wave 2c).
 *
 * A row holds the *current* version of a doc; each doc is uniquely keyed by
 * `(workspace_id, doc_type)` among non-deleted rows. Every regeneration
 * soft-deletes the previous row and inserts a new one; the full immutable
 * history lives in the sibling `platform_doc_versions` table.
 *
 * `generated_by` marks the flavor of synthesis (pure-query mechanical,
 * LLM-only, or hybrid template+LLM). Wave 2c only lands mechanical rows;
 * Waves 4 and 5 add LLM + hybrid on the same schema.
 *
 * `source` is a free-form JSON blob so each extractor can stash whatever
 * provenance it wants (row counts, repo ids, filter knobs, etc.) without a
 * schema change per doc type.
 */

export const TABLE = "code_intel_platform_docs";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      doc_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content_md TEXT NOT NULL,
      source TEXT DEFAULT '{}',
      generated_by TEXT NOT NULL DEFAULT 'mechanical',
      generated_from_run_id TEXT,
      model TEXT,
      generated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_active
      ON ${TABLE}(workspace_id, doc_type) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_workspace ON ${TABLE}(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_doc_type ON ${TABLE}(doc_type);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      workspace_id UUID NOT NULL,
      doc_type TEXT NOT NULL,
      title TEXT NOT NULL,
      content_md TEXT NOT NULL,
      source JSONB DEFAULT '{}'::jsonb,
      generated_by TEXT NOT NULL DEFAULT 'mechanical'
        CHECK (generated_by IN ('mechanical','llm','hybrid')),
      generated_from_run_id UUID,
      model TEXT,
      generated_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_active
      ON ${TABLE}(workspace_id, doc_type) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_workspace ON ${TABLE}(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_doc_type ON ${TABLE}(doc_type);
  `;
}
