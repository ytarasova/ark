/**
 * TenantRepository -- drizzle-backed adapter for the `tenants` table.
 *
 * Public surface (method signatures, `TenantRow` shape) matches the
 * pre-cutover hand-rolled SQL version so callers under `auth/tenants.ts`
 * and `server/handlers/*` compile unchanged. Internals issue typed
 * drizzle queries via `drizzleFromIDatabase(db)`.
 *
 * Soft-delete semantics: every read filters `deleted_at IS NULL` unless
 * the caller passes `{ includeDeleted: true }`.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { now } from "../util/time.js";

export type TenantStatus = "active" | "suspended" | "archived";

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListOptions {
  includeDeleted?: boolean;
}

type DrizzleSelectTenant = {
  id: string;
  slug: string;
  name: string;
  status: string;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

function toPublic(row: DrizzleSelectTenant): TenantRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as TenantStatus,
    deleted_at: row.deletedAt ?? null,
    deleted_by: row.deletedBy ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function tenantsTable(d: DrizzleClient) {
  return d.schema.tenants;
}

export class TenantRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  async list(opts: ListOptions = {}): Promise<TenantRow[]> {
    const d = this.d();
    const t = tenantsTable(d);
    const rows = opts.includeDeleted
      ? await (d.db as any).select().from(t).orderBy(asc(t.slug))
      : await (d.db as any).select().from(t).where(isNull(t.deletedAt)).orderBy(asc(t.slug));
    return (rows as DrizzleSelectTenant[]).map(toPublic);
  }

  async get(id: string, opts: ListOptions = {}): Promise<TenantRow | null> {
    const d = this.d();
    const t = tenantsTable(d);
    const where = opts.includeDeleted ? eq(t.id, id) : and(eq(t.id, id), isNull(t.deletedAt));
    const rows = await (d.db as any).select().from(t).where(where).limit(1);
    const row = (rows as DrizzleSelectTenant[])[0];
    return row ? toPublic(row) : null;
  }

  async getBySlug(slug: string, opts: ListOptions = {}): Promise<TenantRow | null> {
    const d = this.d();
    const t = tenantsTable(d);
    const where = opts.includeDeleted ? eq(t.slug, slug) : and(eq(t.slug, slug), isNull(t.deletedAt));
    const rows = await (d.db as any).select().from(t).where(where).limit(1);
    const row = (rows as DrizzleSelectTenant[])[0];
    return row ? toPublic(row) : null;
  }

  async create(t: { id: string; slug: string; name: string; status?: TenantStatus }): Promise<TenantRow> {
    const ts = now();
    const d = this.d();
    const table = tenantsTable(d);
    await (d.db as any).insert(table).values({
      id: t.id,
      slug: t.slug,
      name: t.name,
      status: t.status ?? "active",
      createdAt: ts,
      updatedAt: ts,
    });
    return (await this.get(t.id))!;
  }

  async update(id: string, fields: Partial<Pick<TenantRow, "slug" | "name" | "status">>): Promise<TenantRow | null> {
    const d = this.d();
    const t = tenantsTable(d);
    const set: Record<string, any> = { updatedAt: now() };
    if (fields.slug !== undefined) set.slug = fields.slug;
    if (fields.name !== undefined) set.name = fields.name;
    if (fields.status !== undefined) set.status = fields.status;
    await (d.db as any).update(t).set(set).where(eq(t.id, id));
    return this.get(id);
  }

  /**
   * Soft-delete: sets `deleted_at` + `deleted_by` on the live row.
   * Idempotent -- calling on an already-soft-deleted row returns `true`
   * without overwriting the original audit fields.
   */
  async softDelete(id: string, userId: string | null = null): Promise<boolean> {
    const d = this.d();
    const t = tenantsTable(d);
    const rows = await (d.db as any).select({ deletedAt: t.deletedAt }).from(t).where(eq(t.id, id)).limit(1);
    const existing = (rows as Array<{ deletedAt: string | null }>)[0];
    if (!existing) return false;
    if (existing.deletedAt) return true;
    const ts = now();
    if (d.dialect === "sqlite") {
      const raw = (this.db as any).db ?? null;
      // Fall through to drizzle-based update below
      void raw;
    }
    const res = await (d.db as any)
      .update(t)
      .set({ deletedAt: ts, deletedBy: userId, updatedAt: ts })
      .where(and(eq(t.id, id), isNull(t.deletedAt)));
    return extractChanges(res) > 0;
  }

  async restore(id: string): Promise<boolean> {
    const d = this.d();
    const t = tenantsTable(d);
    const res = await (d.db as any)
      .update(t)
      .set({ deletedAt: null, deletedBy: null, updatedAt: now() })
      .where(eq(t.id, id));
    return extractChanges(res) > 0;
  }
}

/**
 * drizzle's update()/delete() resolve to different shapes per driver.
 * bun-sqlite: { changes, lastInsertRowid }
 * postgres-js: an array-like result with rowCount
 *
 * Normalise to a number so `softDelete`/`restore` return booleans
 * regardless of dialect.
 */
export function extractChanges(res: unknown): number {
  if (!res || typeof res !== "object") return 0;
  const r = res as { changes?: number; rowCount?: number; count?: number };
  if (typeof r.changes === "number") return r.changes;
  if (typeof r.rowCount === "number") return r.rowCount;
  if (typeof r.count === "number") return r.count;
  return 0;
}
