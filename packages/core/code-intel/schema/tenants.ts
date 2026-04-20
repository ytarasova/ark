/**
 * tenants -- root of the multi-tenant tree.
 *
 * Every row in every other code-intel table FKs back here via tenant_id.
 * Local mode seeds one "default" tenant at migration time; control-plane
 * inserts rows via `ark tenant create`.
 */

export const TABLE = "code_intel_tenants";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_slug ON ${TABLE}(slug);
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE}_slug ON ${TABLE}(slug);
  `;
}
