/**
 * file_hotspots -- per-file activity metrics.
 *
 * Computed, not user-written: change counts in windows, authors touching,
 * lines touched, blended risk score. One row per (file_id) per run.
 */

export const TABLE = "code_intel_file_hotspots";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      change_count_30d INTEGER NOT NULL DEFAULT 0,
      change_count_90d INTEGER NOT NULL DEFAULT 0,
      authors_count INTEGER NOT NULL DEFAULT 0,
      lines_touched INTEGER NOT NULL DEFAULT 0,
      risk_score REAL NOT NULL DEFAULT 0.0,
      computed_at TEXT NOT NULL,
      indexing_run_id TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_file ON ${TABLE}(file_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_risk ON ${TABLE}(risk_score DESC);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      file_id UUID NOT NULL,
      change_count_30d INTEGER NOT NULL DEFAULT 0,
      change_count_90d INTEGER NOT NULL DEFAULT 0,
      authors_count INTEGER NOT NULL DEFAULT 0,
      lines_touched INTEGER NOT NULL DEFAULT 0,
      risk_score DOUBLE PRECISION NOT NULL DEFAULT 0.0,
      computed_at TIMESTAMPTZ NOT NULL,
      indexing_run_id UUID NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_file ON ${TABLE}(file_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_risk ON ${TABLE}(risk_score DESC);
  `;
}
