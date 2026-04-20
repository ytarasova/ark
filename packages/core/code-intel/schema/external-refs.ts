/**
 * external_refs -- first-class dangling cross-repo references.
 *
 * When a symbol references something that lives in an un-indexed repo, the
 * edge lands here with `resolved_symbol_id` null. When the target repo is
 * indexed later, a resolver fills the pointer in -- no dangling graph rows.
 */

export const TABLE = "code_intel_external_refs";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      external_repo_hint TEXT,
      external_fqn TEXT NOT NULL,
      resolved_symbol_id TEXT,
      resolved_at TEXT,
      indexing_run_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_symbol ON ${TABLE}(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_resolved ON ${TABLE}(resolved_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      symbol_id UUID NOT NULL,
      external_repo_hint TEXT,
      external_fqn TEXT NOT NULL,
      resolved_symbol_id UUID,
      resolved_at TIMESTAMPTZ,
      indexing_run_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_symbol ON ${TABLE}(symbol_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_resolved ON ${TABLE}(resolved_symbol_id);
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_tenant ON ${TABLE}(tenant_id);
  `;
}
