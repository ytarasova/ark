/**
 * UserRepository -- drizzle-backed adapter for the `users` table.
 *
 * Users are soft-deletable identities; email uniqueness is enforced by a
 * partial unique index scoped to live rows. Public surface preserved
 * from the pre-cutover hand-rolled SQL version.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { now } from "../util/time.js";
import { extractChanges } from "./tenants.js";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListOptions {
  includeDeleted?: boolean;
}

type DrizzleSelectUser = {
  id: string;
  email: string;
  name: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

function toPublic(row: DrizzleSelectUser): UserRow {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    deleted_at: row.deletedAt ?? null,
    deleted_by: row.deletedBy ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export class UserRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  async list(opts: ListOptions = {}): Promise<UserRow[]> {
    const d = this.d();
    const u = d.schema.users;
    const rows = opts.includeDeleted
      ? await (d.db as any).select().from(u).orderBy(asc(u.email))
      : await (d.db as any).select().from(u).where(isNull(u.deletedAt)).orderBy(asc(u.email));
    return (rows as DrizzleSelectUser[]).map(toPublic);
  }

  async get(id: string, opts: ListOptions = {}): Promise<UserRow | null> {
    const d = this.d();
    const u = d.schema.users;
    const where = opts.includeDeleted ? eq(u.id, id) : and(eq(u.id, id), isNull(u.deletedAt));
    const rows = await (d.db as any).select().from(u).where(where).limit(1);
    const row = (rows as DrizzleSelectUser[])[0];
    return row ? toPublic(row) : null;
  }

  async getByEmail(email: string, opts: ListOptions = {}): Promise<UserRow | null> {
    const d = this.d();
    const u = d.schema.users;
    const where = opts.includeDeleted ? eq(u.email, email) : and(eq(u.email, email), isNull(u.deletedAt));
    const rows = await (d.db as any).select().from(u).where(where).limit(1);
    const row = (rows as DrizzleSelectUser[])[0];
    return row ? toPublic(row) : null;
  }

  async create(u: { email: string; name?: string | null }): Promise<UserRow> {
    const id = `u-${randomBytes(6).toString("hex")}`;
    const ts = now();
    const d = this.d();
    await (d.db as any).insert(d.schema.users).values({
      id,
      email: u.email,
      name: u.name ?? null,
      createdAt: ts,
      updatedAt: ts,
    });
    return (await this.get(id))!;
  }

  async upsertByEmail(u: { email: string; name?: string | null }): Promise<UserRow> {
    const existing = await this.getByEmail(u.email);
    if (existing) {
      if (u.name !== undefined && u.name !== existing.name) {
        const d = this.d();
        await (d.db as any)
          .update(d.schema.users)
          .set({ name: u.name ?? null, updatedAt: now() })
          .where(eq(d.schema.users.id, existing.id));
        return (await this.get(existing.id))!;
      }
      return existing;
    }
    return this.create(u);
  }

  async softDelete(id: string, userId: string | null = null): Promise<boolean> {
    const d = this.d();
    const u = d.schema.users;
    const rows = await (d.db as any).select({ deletedAt: u.deletedAt }).from(u).where(eq(u.id, id)).limit(1);
    const existing = (rows as Array<{ deletedAt: string | null }>)[0];
    if (!existing) return false;
    if (existing.deletedAt) return true;
    const ts = now();
    const res = await (d.db as any)
      .update(u)
      .set({ deletedAt: ts, deletedBy: userId, updatedAt: ts })
      .where(and(eq(u.id, id), isNull(u.deletedAt)));
    return extractChanges(res) > 0;
  }

  async restore(id: string): Promise<boolean> {
    const d = this.d();
    const u = d.schema.users;
    const res = await (d.db as any)
      .update(u)
      .set({ deletedAt: null, deletedBy: null, updatedAt: now() })
      .where(eq(u.id, id));
    return extractChanges(res) > 0;
  }
}
