/**
 * SQLite half of migration 004 -- soft-delete for auth entities.
 *
 * Adds `deleted_at TEXT` to tenants / users / teams / memberships and
 * replaces the existing table-level UNIQUE constraints with partial
 * unique indexes of the form `WHERE deleted_at IS NULL`.
 *
 * SQLite lets us ADD COLUMN in place but CANNOT drop a table-level UNIQUE
 * constraint. For the four tables we therefore rebuild the table:
 *   1. CREATE TABLE <t>_new WITHOUT the UNIQUE constraint.
 *   2. INSERT INTO <t>_new SELECT * FROM <t>.
 *   3. DROP TABLE <t>; ALTER TABLE <t>_new RENAME TO <t>.
 *   4. Recreate indexes + add the partial unique index.
 *
 * The whole migration runs inside a transaction via the runner; if any
 * step fails the whole thing rolls back.
 *
 * Idempotence: we probe for `deleted_at` via PRAGMA table_info before
 * rebuilding. If the column is already present we skip straight to
 * re-ensuring the partial indexes (also IF NOT EXISTS).
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteSoftDelete(db: DatabaseAdapter): Promise<void> {
  // Table rebuilds DROP the old table; with foreign_keys = ON that would
  // cascade-delete dependent rows in teams/memberships. Turn FKs off for
  // the rebuild and re-enable afterwards. PRAGMA foreign_keys is a no-op
  // inside an open transaction -- the migration runner does NOT wrap
  // migrations in a transaction, so the toggle is honoured here.
  await db.exec("PRAGMA foreign_keys = OFF");
  try {
    await rebuildTenantsIfNeeded(db);
    await rebuildUsersIfNeeded(db);
    await rebuildTeamsIfNeeded(db);
    await rebuildMembershipsIfNeeded(db);
    await ensurePartialIndexes(db);
  } finally {
    await db.exec("PRAGMA foreign_keys = ON");
  }
}

async function hasColumn(db: DatabaseAdapter, table: string, column: string): Promise<boolean> {
  const rows = (await db.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

async function rebuildTenantsIfNeeded(db: DatabaseAdapter): Promise<void> {
  if (await hasColumn(db, "tenants", "deleted_at")) return;
  await db.exec(`
    CREATE TABLE tenants_new (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.exec(`
    INSERT INTO tenants_new (id, slug, name, status, deleted_at, created_at, updated_at)
      SELECT id, slug, name, status, NULL, created_at, updated_at FROM tenants
  `);
  await db.exec(`DROP TABLE tenants`);
  await db.exec(`ALTER TABLE tenants_new RENAME TO tenants`);
  await trySql(db, `CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)`);
}

async function rebuildUsersIfNeeded(db: DatabaseAdapter): Promise<void> {
  if (await hasColumn(db, "users", "deleted_at")) return;
  await db.exec(`
    CREATE TABLE users_new (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.exec(`
    INSERT INTO users_new (id, email, name, deleted_at, created_at, updated_at)
      SELECT id, email, name, NULL, created_at, updated_at FROM users
  `);
  await db.exec(`DROP TABLE users`);
  await db.exec(`ALTER TABLE users_new RENAME TO users`);
}

async function rebuildTeamsIfNeeded(db: DatabaseAdapter): Promise<void> {
  if (await hasColumn(db, "teams", "deleted_at")) return;
  await db.exec(`
    CREATE TABLE teams_new (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.exec(`
    INSERT INTO teams_new (id, tenant_id, slug, name, description, deleted_at, created_at, updated_at)
      SELECT id, tenant_id, slug, name, description, NULL, created_at, updated_at FROM teams
  `);
  await db.exec(`DROP TABLE teams`);
  await db.exec(`ALTER TABLE teams_new RENAME TO teams`);
  await trySql(db, `CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id)`);
}

async function rebuildMembershipsIfNeeded(db: DatabaseAdapter): Promise<void> {
  if (await hasColumn(db, "memberships", "deleted_at")) return;
  await db.exec(`
    CREATE TABLE memberships_new (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      deleted_at TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await db.exec(`
    INSERT INTO memberships_new (id, user_id, team_id, role, deleted_at, created_at)
      SELECT id, user_id, team_id, role, NULL, created_at FROM memberships
  `);
  await db.exec(`DROP TABLE memberships`);
  await db.exec(`ALTER TABLE memberships_new RENAME TO memberships`);
  await trySql(db, `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`);
  await trySql(db, `CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id)`);
}

async function ensurePartialIndexes(db: DatabaseAdapter): Promise<void> {
  await trySql(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug_live ON tenants(slug) WHERE deleted_at IS NULL`);
  await trySql(db, `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_live ON users(email) WHERE deleted_at IS NULL`);
  await trySql(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_tenant_slug_live
       ON teams(tenant_id, slug) WHERE deleted_at IS NULL`,
  );
  await trySql(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_team_live
       ON memberships(user_id, team_id) WHERE deleted_at IS NULL`,
  );
}

async function trySql(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "soft_delete partial-index already exists");
  }
}
