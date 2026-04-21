/**
 * Postgres half of migration 004 -- soft-delete for auth entities.
 *
 * Adds `deleted_at TEXT` to tenants / users / teams / memberships, drops
 * the existing UNIQUE constraints, and creates partial unique indexes
 * scoped to live rows (`WHERE deleted_at IS NULL`).
 *
 * Postgres supports partial unique indexes since 7.2, so we never need
 * the SQLite-style table rebuild.
 *
 * Every statement is idempotent:
 *   - ADD COLUMN IF NOT EXISTS
 *   - DROP CONSTRAINT IF EXISTS
 *   - CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE deleted_at IS NULL
 *
 * Known-name UNIQUE constraints from migration 003 are dropped
 * defensively via information_schema lookup so an install that auto-
 * generated a different constraint name still ends up with the partial
 * index as the sole uniqueness guard.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresSoftDelete(db: IDatabase): Promise<void> {
  await addColumn(db, "tenants");
  await addColumn(db, "users");
  await addColumn(db, "teams");
  await addColumn(db, "memberships");

  await dropUniqueConstraints(db, "tenants", ["slug"]);
  await dropUniqueConstraints(db, "users", ["email"]);
  await dropUniqueConstraints(db, "teams", ["tenant_id", "slug"]);
  await dropUniqueConstraints(db, "memberships", ["user_id", "team_id"]);

  const indexSql = [
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug_live ON tenants(slug) WHERE deleted_at IS NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_live ON users(email) WHERE deleted_at IS NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tenant_slug_live ON teams(tenant_id, slug) WHERE deleted_at IS NULL",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_team_live ON memberships(user_id, team_id) WHERE deleted_at IS NULL",
  ];
  for (const sql of indexSql) {
    await trySql(db, sql);
  }
}

async function addColumn(db: IDatabase, table: string): Promise<void> {
  await trySql(db, "ALTER TABLE " + table + " ADD COLUMN IF NOT EXISTS deleted_at TEXT");
}

/**
 * Drop every UNIQUE constraint on `table` whose column set exactly matches
 * `cols` (order-insensitive). Postgres auto-generates constraint names for
 * inline UNIQUE clauses (e.g. `teams_tenant_id_slug_key`); rather than
 * hardcoding those names we resolve them via information_schema.
 */
async function dropUniqueConstraints(db: IDatabase, table: string, cols: string[]): Promise<void> {
  try {
    const rows = (await db
      .prepare(
        `SELECT tc.constraint_name AS name,
                array_agg(kcu.column_name ORDER BY kcu.ordinal_position) AS columns
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name
            AND kcu.table_schema = tc.table_schema
          WHERE tc.table_name = $1
            AND tc.table_schema = current_schema()
            AND tc.constraint_type = 'UNIQUE'
          GROUP BY tc.constraint_name`,
      )
      .all(table)) as Array<{ name: string; columns: string[] }>;
    const want = [...cols].sort().join(",");
    for (const r of rows) {
      const got = [...r.columns].sort().join(",");
      if (got === want) {
        await trySql(db, "ALTER TABLE " + table + ' DROP CONSTRAINT IF EXISTS "' + r.name + '"');
      }
    }
  } catch {
    logDebug("general", "soft_delete unique-constraint lookup skipped");
  }
}

async function trySql(db: IDatabase, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "soft_delete Postgres DDL already applied");
  }
}
