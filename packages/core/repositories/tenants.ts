/**
 * TenantRepository -- thin SQL adapter for the `tenants` table.
 *
 * The table is created by migration 003 (`003_tenants_teams.ts`) and
 * gains the `deleted_at` column in migration 004. Callers typically
 * reach it through `TenantManager` (packages/core/auth/tenants.ts).
 *
 * Soft-delete semantics: every read (`list`, `get`, `getBySlug`) filters
 * `deleted_at IS NULL` by default so soft-deleted rows are invisible.
 * Admin surfaces that need the tombstones can pass `{ includeDeleted: true }`.
 */

import type { IDatabase } from "../database/index.js";
import { now } from "../util/time.js";

export type TenantStatus = "active" | "suspended" | "archived";

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListOptions {
  includeDeleted?: boolean;
}

const COLUMNS = new Set(["slug", "name", "status", "updated_at"]);

export class TenantRepository {
  constructor(private db: IDatabase) {}

  async list(opts: ListOptions = {}): Promise<TenantRow[]> {
    const where = opts.includeDeleted ? "" : "WHERE deleted_at IS NULL";
    const rows = (await this.db.prepare(`SELECT * FROM tenants ${where} ORDER BY slug ASC`).all()) as TenantRow[];
    return rows;
  }

  async get(id: string, opts: ListOptions = {}): Promise<TenantRow | null> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM tenants WHERE id = ?"
      : "SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL";
    const row = (await this.db.prepare(sql).get(id)) as TenantRow | undefined;
    return row ?? null;
  }

  async getBySlug(slug: string, opts: ListOptions = {}): Promise<TenantRow | null> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM tenants WHERE slug = ?"
      : "SELECT * FROM tenants WHERE slug = ? AND deleted_at IS NULL";
    const row = (await this.db.prepare(sql).get(slug)) as TenantRow | undefined;
    return row ?? null;
  }

  async create(t: { id: string; slug: string; name: string; status?: TenantStatus }): Promise<TenantRow> {
    const ts = now();
    await this.db
      .prepare("INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.id, t.slug, t.name, t.status ?? "active", ts, ts);
    return (await this.get(t.id))!;
  }

  async update(id: string, fields: Partial<Pick<TenantRow, "slug" | "name" | "status">>): Promise<TenantRow | null> {
    const updates: string[] = ["updated_at = ?"];
    const values: any[] = [now()];
    for (const [key, value] of Object.entries(fields)) {
      if (!COLUMNS.has(key)) continue;
      updates.push(`${key} = ?`);
      values.push(value);
    }
    values.push(id);
    await this.db.prepare(`UPDATE tenants SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  /**
   * Soft-delete: sets `deleted_at` to now() if not already set. Idempotent --
   * calling on an already-soft-deleted row is a no-op and returns `true` so
   * the caller sees the same result as the first call.
   */
  async softDelete(id: string): Promise<boolean> {
    const existing = (await this.db.prepare("SELECT deleted_at FROM tenants WHERE id = ?").get(id)) as
      | { deleted_at: string | null }
      | undefined;
    if (!existing) return false;
    if (existing.deleted_at) return true;
    const ts = now();
    const res = await this.db
      .prepare("UPDATE tenants SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(ts, ts, id);
    return res.changes > 0;
  }

  async restore(id: string): Promise<boolean> {
    const res = await this.db
      .prepare("UPDATE tenants SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL")
      .run(now(), id);
    return res.changes > 0;
  }
}
