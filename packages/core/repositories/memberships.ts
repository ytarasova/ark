/**
 * MembershipRepository -- drizzle-backed adapter for the `memberships` table.
 *
 * A membership binds a user to a team with a flat role string. Soft-delete
 * semantics: `deleted_at IS NULL` for live rows. `(user_id, team_id)` is
 * unique only among live rows (partial unique index).
 *
 * Public surface preserved from the pre-cutover hand-rolled SQL version.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import { randomBytes } from "crypto";
import { now } from "../util/time.js";
import { extractChanges } from "./tenants.js";

export type MembershipRole = "owner" | "admin" | "member" | "viewer";

export interface MembershipRow {
  id: string;
  user_id: string;
  team_id: string;
  role: MembershipRole;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
}

export interface MembershipWithUser extends MembershipRow {
  email: string;
  name: string | null;
}

export interface ListOptions {
  includeDeleted?: boolean;
}

type DrizzleSelectMembership = {
  id: string;
  userId: string;
  teamId: string;
  role: string;
  deletedAt: string | null;
  deletedBy: string | null;
  createdAt: string;
};

function toPublic(row: DrizzleSelectMembership): MembershipRow {
  return {
    id: row.id,
    user_id: row.userId,
    team_id: row.teamId,
    role: row.role as MembershipRole,
    deleted_at: row.deletedAt ?? null,
    deleted_by: row.deletedBy ?? null,
    created_at: row.createdAt,
  };
}

export class MembershipRepository {
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  async listByTeam(teamId: string, opts: ListOptions = {}): Promise<MembershipWithUser[]> {
    const d = this.d();
    const m = d.schema.memberships;
    const u = d.schema.users;
    const where = opts.includeDeleted
      ? eq(m.teamId, teamId)
      : and(eq(m.teamId, teamId), isNull(m.deletedAt), isNull(u.deletedAt));
    const rows = await (d.db as any)
      .select({
        id: m.id,
        userId: m.userId,
        teamId: m.teamId,
        role: m.role,
        deletedAt: m.deletedAt,
        deletedBy: m.deletedBy,
        createdAt: m.createdAt,
        email: u.email,
        name: u.name,
      })
      .from(m)
      .innerJoin(u, eq(u.id, m.userId))
      .where(where)
      .orderBy(asc(u.email));
    return (rows as Array<DrizzleSelectMembership & { email: string; name: string | null }>).map((r) => ({
      ...toPublic(r),
      email: r.email,
      name: r.name ?? null,
    }));
  }

  async listByUser(userId: string, opts: ListOptions = {}): Promise<MembershipRow[]> {
    const d = this.d();
    const m = d.schema.memberships;
    const where = opts.includeDeleted ? eq(m.userId, userId) : and(eq(m.userId, userId), isNull(m.deletedAt));
    const rows = await (d.db as any).select().from(m).where(where).orderBy(asc(m.createdAt));
    return (rows as DrizzleSelectMembership[]).map(toPublic);
  }

  async get(userId: string, teamId: string, opts: ListOptions = {}): Promise<MembershipRow | null> {
    const d = this.d();
    const m = d.schema.memberships;
    const where = opts.includeDeleted
      ? and(eq(m.userId, userId), eq(m.teamId, teamId))
      : and(eq(m.userId, userId), eq(m.teamId, teamId), isNull(m.deletedAt));
    const rows = await (d.db as any).select().from(m).where(where).limit(1);
    const row = (rows as DrizzleSelectMembership[])[0];
    return row ? toPublic(row) : null;
  }

  async add(userId: string, teamId: string, role: MembershipRole): Promise<MembershipRow> {
    const existing = await this.get(userId, teamId);
    if (existing) {
      if (existing.role !== role) {
        const d = this.d();
        const m = d.schema.memberships;
        await (d.db as any)
          .update(m)
          .set({ role })
          .where(and(eq(m.userId, userId), eq(m.teamId, teamId), isNull(m.deletedAt)));
        return (await this.get(userId, teamId))!;
      }
      return existing;
    }
    const id = `m-${randomBytes(6).toString("hex")}`;
    const d = this.d();
    await (d.db as any).insert(d.schema.memberships).values({
      id,
      userId,
      teamId,
      role,
      createdAt: now(),
    });
    return (await this.get(userId, teamId))!;
  }

  /**
   * Soft-remove. Idempotent -- calling on an already-soft-deleted row
   * returns `true` without overwriting audit fields.
   */
  async softRemove(userId: string, teamId: string, deletedBy: string | null = null): Promise<boolean> {
    const d = this.d();
    const m = d.schema.memberships;
    const rows = await (d.db as any)
      .select({ deletedAt: m.deletedAt })
      .from(m)
      .where(and(eq(m.userId, userId), eq(m.teamId, teamId)))
      .limit(1);
    const row = (rows as Array<{ deletedAt: string | null }>)[0];
    if (!row) return false;
    if (row.deletedAt) return true;
    const res = await (d.db as any)
      .update(m)
      .set({ deletedAt: now(), deletedBy })
      .where(and(eq(m.userId, userId), eq(m.teamId, teamId), isNull(m.deletedAt)));
    return extractChanges(res) > 0;
  }

  async restore(userId: string, teamId: string): Promise<boolean> {
    const d = this.d();
    const m = d.schema.memberships;
    const res = await (d.db as any)
      .update(m)
      .set({ deletedAt: null, deletedBy: null })
      .where(and(eq(m.userId, userId), eq(m.teamId, teamId)));
    return extractChanges(res) > 0;
  }

  async setRole(userId: string, teamId: string, role: MembershipRole): Promise<MembershipRow | null> {
    const d = this.d();
    const m = d.schema.memberships;
    await (d.db as any)
      .update(m)
      .set({ role })
      .where(and(eq(m.userId, userId), eq(m.teamId, teamId), isNull(m.deletedAt)));
    return this.get(userId, teamId);
  }

  async softRemoveByTeam(teamId: string, deletedBy: string | null = null): Promise<void> {
    const d = this.d();
    const m = d.schema.memberships;
    await (d.db as any)
      .update(m)
      .set({ deletedAt: now(), deletedBy })
      .where(and(eq(m.teamId, teamId), isNull(m.deletedAt)));
  }

  async softRemoveByUser(userId: string, deletedBy: string | null = null): Promise<void> {
    const d = this.d();
    const m = d.schema.memberships;
    await (d.db as any)
      .update(m)
      .set({ deletedAt: now(), deletedBy })
      .where(and(eq(m.userId, userId), isNull(m.deletedAt)));
  }
}
