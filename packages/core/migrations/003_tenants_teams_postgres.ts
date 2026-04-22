/**
 * Postgres half of migration 003 -- tenants + users + teams + memberships.
 *
 * Uses CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING so every
 * statement is idempotent. The backfill pulls every distinct `tenant_id`
 * from sessions / computes / tenant_policies etc. Each SELECT is wrapped
 * in tryRun so older installs (missing one of the source tables) don't
 * break the migration.
 *
 * A defensive CREATE TABLE IF NOT EXISTS for `tenants` stays on top even
 * though schema-postgres.ts also defines it -- MigrationRunner may mark
 * 001 as applied via absorbLegacyInstall on long-lived installs that
 * never re-ran initPostgresSchema, so this keeps the INSERT below safe.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applyPostgresTenantsTeams(db: DatabaseAdapter): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await tryRun(db, `CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, slug)
    )
  `);
  await tryRun(db, `CREATE INDEX IF NOT EXISTS idx_teams_tenant ON teams(tenant_id)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL,
      UNIQUE (user_id, team_id)
    )
  `);
  await tryRun(db, `CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id)`);
  await tryRun(db, `CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id)`);

  await backfillFrom(db, "sessions");
  await backfillFrom(db, "computes");
  await backfillFrom(db, "compute");
  await backfillFrom(db, "tenant_policies");
  await backfillFrom(db, "events");
  await backfillFrom(db, "messages");
  await backfillFrom(db, "todos");
  await backfillFrom(db, "schedules");

  await tryRun(
    db,
    `INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
     VALUES ('default', 'default', 'default', 'active', NOW()::TEXT, NOW()::TEXT)
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function backfillFrom(db: DatabaseAdapter, table: string): Promise<void> {
  await tryRun(
    db,
    `INSERT INTO tenants (id, slug, name, status, created_at, updated_at)
     SELECT DISTINCT tenant_id, tenant_id, tenant_id, 'active', NOW()::TEXT, NOW()::TEXT
     FROM ${table}
     WHERE tenant_id IS NOT NULL AND tenant_id <> ''
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function tryRun(db: DatabaseAdapter, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "tenants_teams backfill skipped (source table absent)");
  }
}
