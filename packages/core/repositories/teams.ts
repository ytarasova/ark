/**
 * TeamRepository -- SQL adapter for the `teams` table.
 *
 * Teams live inside a tenant -- `(tenant_id, slug)` is unique among live
 * rows (partial unique index, see migration 004). The table is created by
 * migration 003 with an FK to `tenants(id) ON DELETE CASCADE`.
 *
 * Soft-delete: every read filters `deleted_at IS NULL` unless the caller
 * explicitly opts in with `{ includeDeleted: true }`.
 */

import type { IDatabase } from "../database/index.js";
import { now } from "../util/time.js";

export interface TeamRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListOptions {
  includeDeleted?: boolean;
}

const COLUMNS = new Set(["slug", "name", "description", "updated_at"]);

export class TeamRepository {
  constructor(private db: IDatabase) {}

  async listByTenant(tenantId: string, opts: ListOptions = {}): Promise<TeamRow[]> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM teams WHERE tenant_id = ? ORDER BY slug ASC"
      : "SELECT * FROM teams WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY slug ASC";
    const rows = (await this.db.prepare(sql).all(tenantId)) as TeamRow[];
    return rows;
  }

  async get(id: string, opts: ListOptions = {}): Promise<TeamRow | null> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM teams WHERE id = ?"
      : "SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL";
    const row = (await this.db.prepare(sql).get(id)) as TeamRow | undefined;
    return row ?? null;
  }

  async create(t: {
    id: string;
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
  }): Promise<TeamRow> {
    const ts = now();
    await this.db
      .prepare(
        "INSERT INTO teams (id, tenant_id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.id, t.tenant_id, t.slug, t.name, t.description ?? null, ts, ts);
    return (await this.get(t.id))!;
  }

  async update(id: string, fields: Partial<Pick<TeamRow, "slug" | "name" | "description">>): Promise<TeamRow | null> {
    const updates: string[] = ["updated_at = ?"];
    const values: any[] = [now()];
    for (const [key, value] of Object.entries(fields)) {
      if (!COLUMNS.has(key)) continue;
      updates.push(`${key} = ?`);
      values.push(value ?? null);
    }
    values.push(id);
    await this.db.prepare(`UPDATE teams SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  async softDelete(id: string, userId: string | null = null): Promise<boolean> {
    const existing = (await this.db.prepare("SELECT deleted_at FROM teams WHERE id = ?").get(id)) as
      | { deleted_at: string | null }
      | undefined;
    if (!existing) return false;
    if (existing.deleted_at) return true;
    const ts = now();
    const res = await this.db
      .prepare("UPDATE teams SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(ts, userId, ts, id);
    return res.changes > 0;
  }

  async restore(id: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE teams SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
      )
      .run(now(), id);
    return res.changes > 0;
  }

  /**
   * Cascade helper -- soft-delete every team in a tenant. Used when a
   * tenant is itself soft-deleted so downstream rows don't remain
   * visible to `list()` callers. Idempotent. `userId` is attributed to
   * every cascaded row so the audit trail identifies the upstream actor.
   */
  async softDeleteByTenant(tenantId: string, userId: string | null = null): Promise<void> {
    const ts = now();
    await this.db
      .prepare(
        "UPDATE teams SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE tenant_id = ? AND deleted_at IS NULL",
      )
      .run(ts, userId, ts, tenantId);
  }
}
