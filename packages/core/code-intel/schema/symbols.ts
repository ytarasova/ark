/**
 * symbols -- first-class named entities (classes, functions, methods, ...).
 *
 * `parent_symbol_id` supports hierarchy (a class contains methods).
 * `kind` is an open enum; check is enforced in Postgres but not SQLite
 * (SQLite CHECK constraints aren't portable across bun:sqlite + WASM).
 */

export const TABLE = "code_intel_symbols";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      fqn TEXT,
      signature TEXT,
      line_start INTEGER,
      line_end INTEGER,
      parent_symbol_id TEXT,
      indexing_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_file ON ${TABLE}(file_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_name ON ${TABLE}(name);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_fqn ON ${TABLE}(fqn);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_kind ON ${TABLE}(kind);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_parent ON ${TABLE}(parent_symbol_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      file_id UUID NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('class','function','method','struct','enum','var','interface','module','other')),
      name TEXT NOT NULL,
      fqn TEXT,
      signature TEXT,
      line_start INTEGER,
      line_end INTEGER,
      parent_symbol_id UUID,
      indexing_run_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      deleted_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_file ON ${TABLE}(file_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_name ON ${TABLE}(name);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_fqn ON ${TABLE}(fqn);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_kind ON ${TABLE}(kind);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_parent ON ${TABLE}(parent_symbol_id);
  `;
}
