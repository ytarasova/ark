/**
 * chunks -- hierarchical content chunks tied to files / symbols.
 *
 * `parent_chunk_id` models "class -> method -> statement" nesting.
 * `attrs` is extensible metadata; callers write structured JSON.
 *
 * FTS: in SQLite a virtual FTS5 table `code_intel_chunks_fts` (created in
 * the migration runner) indexes `content` + `path_hint` + `symbol_name`.
 * In Postgres we add a `tsvector` column in a later wave; for now the
 * Postgres DDL emits an empty GIN-friendly text column only.
 */

export const TABLE = "code_intel_chunks";
export const FTS_TABLE = "code_intel_chunks_fts";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      symbol_id TEXT,
      parent_chunk_id TEXT,
      chunk_kind TEXT NOT NULL DEFAULT 'code',
      content TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      attrs TEXT DEFAULT '{}',
      indexing_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_file ON ${TABLE}(file_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_symbol ON ${TABLE}(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_kind ON ${TABLE}(chunk_kind);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_run ON ${TABLE}(indexing_run_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      chunk_id UNINDEXED,
      tenant_id UNINDEXED,
      content,
      path_hint,
      symbol_name
    );
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      file_id UUID NOT NULL,
      symbol_id UUID,
      parent_chunk_id UUID,
      chunk_kind TEXT NOT NULL DEFAULT 'code'
        CHECK (chunk_kind IN ('code','doc','comment','config','fixture','other')),
      content TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      attrs JSONB DEFAULT '{}'::jsonb,
      indexing_run_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ,
      fts_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content,''))) STORED
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_file ON ${TABLE}(file_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_symbol ON ${TABLE}(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_kind ON ${TABLE}(chunk_kind);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_run ON ${TABLE}(indexing_run_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_fts ON ${TABLE} USING gin(fts_tsv);
  `;
}
