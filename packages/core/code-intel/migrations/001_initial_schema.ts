/**
 * Migration 001 -- create every Wave 1 table and seed the default tenant.
 *
 * Idempotent: every CREATE is `IF NOT EXISTS`, and the seed insert uses
 * `INSERT OR IGNORE` (SQLite) / `ON CONFLICT DO NOTHING` (Postgres).
 */

import type { IDatabase } from "../../database/index.js";
import { sqliteSchema, postgresSchema } from "../schema/index.js";
import { TABLE as TENANTS_TABLE } from "../schema/tenants.js";
import { DEFAULT_TENANT_ID } from "../constants.js";

export const VERSION = 1;
export const NAME = "initial_schema";

export interface MigrationApplyContext {
  db: IDatabase;
  dialect: "sqlite" | "postgres";
}

export function up(ctx: MigrationApplyContext): void {
  const ddl = ctx.dialect === "sqlite" ? sqliteSchema() : postgresSchema();
  ctx.db.exec(ddl);

  // Seed a default tenant so local mode works out of the box.
  const now = new Date().toISOString();
  if (ctx.dialect === "sqlite") {
    ctx.db
      .prepare(`INSERT OR IGNORE INTO ${TENANTS_TABLE} (id, name, slug, created_at) VALUES (?, ?, ?, ?)`)
      .run(DEFAULT_TENANT_ID, "Default", "default", now);
  } else {
    ctx.db
      .prepare(
        `INSERT INTO ${TENANTS_TABLE} (id, name, slug, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      )
      .run(DEFAULT_TENANT_ID, "Default", "default", now);
  }
}
