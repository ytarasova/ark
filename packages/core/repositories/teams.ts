/**
 * TeamRepository -- drizzle-backed adapter for the `teams` table.
 *
 * Teams live inside a tenant. `(tenant_id, slug)` is unique among live
 * rows via a partial unique index. Soft-delete semantics match the
 * tenant repo: every read filters `deleted_at IS NULL` unless the caller
 * explicitly opts in.
 *
 * Public surface (method signatures + `TeamRow` shape) preserved from
 * the pre-cutover hand-rolled SQL version so callers don't have to
 * change. Internals use drizzle's typed query builder.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { now } from "../util/time.js";
import { extractChanges } from "./tenants.js";

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

type DrizzleSelectTeam = {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

function toPublic(row: DrizzleSelectTeam): TeamRow {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    deleted_at: row.deletedAt ?? null,
    deleted_by: row.deletedBy ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export class TeamRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  async listByTenant(tenantId: string, opts: ListOptions = {}): Promise<TeamRow[]> {
    const d = this.d();
    const t = d.schema.teams;
    const where = opts.includeDeleted ? eq(t.tenantId, tenantId) : and(eq(t.tenantId, tenantId), isNull(t.deletedAt));
    const rows = await (d.db as any).select().from(t).where(where).orderBy(asc(t.slug));
    return (rows as DrizzleSelectTeam[]).map(toPublic);
  }

  async get(id: string, opts: ListOptions = {}): Promise<TeamRow | null> {
    const d = this.d();
    const t = d.schema.teams;
    const where = opts.includeDeleted ? eq(t.id, id) : and(eq(t.id, id), isNull(t.deletedAt));
    const rows = await (d.db as any).select().from(t).where(where).limit(1);
    const row = (rows as DrizzleSelectTeam[])[0];
    return row ? toPublic(row) : null;
  }

  async create(t: {
    id: string;
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
  }): Promise<TeamRow> {
    const ts = now();
    const d = this.d();
    const table = d.schema.teams;
    await (d.db as any).insert(table).values({
      id: t.id,
      tenantId: t.tenant_id,
      slug: t.slug,
      name: t.name,
      description: t.description ?? null,
      createdAt: ts,
      updatedAt: ts,
    });
    return (await this.get(t.id))!;
  }

  async update(id: string, fields: Partial<Pick<TeamRow, "slug" | "name" | "description">>): Promise<TeamRow | null> {
    const d = this.d();
    const t = d.schema.teams;
    const set: Record<string, any> = { updatedAt: now() };
    if (fields.slug !== undefined) set.slug = fields.slug;
    if (fields.name !== undefined) set.name = fields.name;
    if (fields.description !== undefined) set.description = fields.description ?? null;
    await (d.db as any).update(t).set(set).where(eq(t.id, id));
    return this.get(id);
  }

  async softDelete(id: string, userId: string | null = null): Promise<boolean> {
    const d = this.d();
    const t = d.schema.teams;
    const rows = await (d.db as any).select({ deletedAt: t.deletedAt }).from(t).where(eq(t.id, id)).limit(1);
    const existing = (rows as Array<{ deletedAt: string | null }>)[0];
    if (!existing) return false;
    if (existing.deletedAt) return true;
    const ts = now();
    const res = await (d.db as any)
      .update(t)
      .set({ deletedAt: ts, deletedBy: userId, updatedAt: ts })
      .where(and(eq(t.id, id), isNull(t.deletedAt)));
    return extractChanges(res) > 0;
  }

  async restore(id: string): Promise<boolean> {
    const d = this.d();
    const t = d.schema.teams;
    const res = await (d.db as any)
      .update(t)
      .set({ deletedAt: null, deletedBy: null, updatedAt: now() })
      .where(eq(t.id, id));
    return extractChanges(res) > 0;
  }

  /** Cascade helper -- soft-delete every team in a tenant. */
  async softDeleteByTenant(tenantId: string, userId: string | null = null): Promise<void> {
    const d = this.d();
    const t = d.schema.teams;
    const ts = now();
    await (d.db as any)
      .update(t)
      .set({ deletedAt: ts, deletedBy: userId, updatedAt: ts })
      .where(and(eq(t.tenantId, tenantId), isNull(t.deletedAt)));
  }
}
