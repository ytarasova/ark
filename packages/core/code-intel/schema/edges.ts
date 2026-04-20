/**
 * edges -- typed graph edges between entities.
 *
 * `(source_kind, source_id)` and `(target_kind, target_id)` replace pi-sage's
 * free-text entity strings. `evidence_chunk_id` links each edge back to the
 * chunk that proved it, so query explanations can cite the source material.
 */

export const TABLE = "code_intel_edges";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      evidence_chunk_id TEXT,
      weight REAL DEFAULT 1.0,
      attrs TEXT DEFAULT '{}',
      indexing_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_source ON ${TABLE}(tenant_id, source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_target ON ${TABLE}(tenant_id, target_kind, target_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_relation ON ${TABLE}(relation);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_run ON ${TABLE}(indexing_run_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      source_kind TEXT NOT NULL,
      source_id UUID NOT NULL,
      target_kind TEXT NOT NULL,
      target_id UUID NOT NULL,
      relation TEXT NOT NULL
        CHECK (relation IN ('calls','imports','depends_on','defines','contains','references','tests','modified_by','deployed_via','interop')),
      evidence_chunk_id UUID,
      weight DOUBLE PRECISION DEFAULT 1.0,
      attrs JSONB DEFAULT '{}'::jsonb,
      indexing_run_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_source ON ${TABLE}(tenant_id, source_kind, source_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_target ON ${TABLE}(tenant_id, target_kind, target_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_relation ON ${TABLE}(relation);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_run ON ${TABLE}(indexing_run_id);
  `;
}
