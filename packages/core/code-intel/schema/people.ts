/**
 * people -- deduped contributor identities.
 *
 * pi-sage repeats a contributor row per file they touched; Ark stores one
 * person and FKs from `contributions`. `alt_emails` / `alt_names` carry
 * historical identities (merge heuristics live in the contributors
 * extractor).
 */

export const TABLE = "code_intel_people";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      primary_email TEXT NOT NULL,
      name TEXT,
      alt_emails TEXT DEFAULT '[]',
      alt_names TEXT DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_email ON ${TABLE}(tenant_id, primary_email);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      tenant_id UUID NOT NULL,
      primary_email TEXT NOT NULL,
      name TEXT,
      alt_emails JSONB DEFAULT '[]'::jsonb,
      alt_names JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_${TABLE}_email ON ${TABLE}(tenant_id, primary_email);
  `;
}
