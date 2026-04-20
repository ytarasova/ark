/**
 * schema_migrations -- tracks which migration versions have been applied.
 *
 * One row per applied migration. `version` is monotonic; the migration
 * runner refuses to run a migration numbered below the current max.
 */

export const TABLE = "code_intel_schema_migrations";

export function sqliteDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `;
}

export function postgresDDL(): string {
  return `
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL
    );
  `;
}
