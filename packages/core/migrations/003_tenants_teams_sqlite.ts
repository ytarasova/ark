/**
 * SQLite half of migration 003 -- tenants + users + teams + memberships.
 *
 * All CREATE TABLE statements use IF NOT EXISTS and every INSERT uses
 * OR IGNORE so re-runs are no-ops. Backfill pulls every distinct
 * `tenant_id` value from sessions / computes / tenant_policies and inserts
 * a row into `tenants` with id = slug = name = the legacy string. The
 * "default" tenant is always ensured.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";

export async function applySqliteTenantsTeams(db: IDatabase): Promise<void> {
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

  // Backfill: pull distinct tenant_id from every table that carries one.
  // Each SELECT is tryRun-wrapped so a missing source table (older install)
  // doesn't break the migration.
  await backfillFrom(db, "sessions");
  await backfillFrom(db, "computes");
  await backfillFrom(db, "compute");
  await backfillFrom(db, "tenant_policies");
  await backfillFrom(db, "events");
  await backfillFrom(db, "messages");
  await backfillFrom(db, "todos");
  await backfillFrom(db, "schedules");

  // Always ensure the "default" tenant exists.
  await tryRun(
    db,
    `INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at, updated_at)
     VALUES ('default', 'default', 'default', 'active', datetime('now'), datetime('now'))`,
  );
}

async function backfillFrom(db: IDatabase, table: string): Promise<void> {
  await tryRun(
    db,
    `INSERT OR IGNORE INTO tenants (id, slug, name, status, created_at, updated_at)
     SELECT DISTINCT tenant_id, tenant_id, tenant_id, 'active', datetime('now'), datetime('now')
     FROM ${table}
     WHERE tenant_id IS NOT NULL AND tenant_id <> ''`,
  );
}

async function tryRun(db: IDatabase, sql: string): Promise<void> {
  try {
    await db.exec(sql);
  } catch {
    logDebug("general", "tenants_teams backfill skipped (source table absent)");
  }
}
