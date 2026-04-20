/**
 * embeddings -- multi-model, multi-subject vector storage.
 *
 * `(tenant_id, subject_kind, subject_id, model, model_version)` is unique
 * so two models can co-embed the same row (A/B testing, gradual upgrades).
 * Local mode stores `vector` as a BLOB; control-plane uses pgvector
 * (DDL here keeps the BYTEA fallback; pgvector wiring lands in Wave 2).
 */

export const TABLE = "code_intel_embeddings";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      model TEXT NOT NULL,
      model_version TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      indexing_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_unique
      ON ${TABLE}(tenant_id, subject_kind, subject_id, model, model_version);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_subject ON ${TABLE}(tenant_id, subject_kind, subject_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id UUID NOT NULL,
      model TEXT NOT NULL,
      model_version TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BYTEA NOT NULL,
      indexing_run_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_unique
      ON ${TABLE}(tenant_id, subject_kind, subject_id, model, model_version);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_subject ON ${TABLE}(tenant_id, subject_kind, subject_id);
  `;
}
