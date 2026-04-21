/**
 * MembershipRepository -- SQL adapter for the `memberships` table.
 *
 * A membership binds a user to a team with a flat role string
 * ("owner" | "admin" | "member" | "viewer"). Authorization decisions are
 * made elsewhere (tenant_policies + future policy code). Role is NOT a
 * permissions matrix -- keep it simple.
 *
 * Soft-delete: `deleted_at` lands in migration 004. `(user_id, team_id)`
 * is unique only among live rows so a user can be removed and re-added.
 */

import type { IDatabase } from "../database/index.js";
import { randomBytes } from "crypto";
import { now } from "../util/time.js";

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

export class MembershipRepository {
  constructor(private db: IDatabase) {}

  async listByTeam(teamId: string, opts: ListOptions = {}): Promise<MembershipWithUser[]> {
    const deletedFilter = opts.includeDeleted ? "" : "AND m.deleted_at IS NULL AND u.deleted_at IS NULL";
    const rows = (await this.db
      .prepare(
        `SELECT m.id, m.user_id, m.team_id, m.role, m.deleted_at, m.deleted_by, m.created_at, u.email, u.name
         FROM memberships m
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.team_id = ? ${deletedFilter}
         ORDER BY u.email ASC`,
      )
      .all(teamId)) as MembershipWithUser[];
    return rows;
  }

  async listByUser(userId: string, opts: ListOptions = {}): Promise<MembershipRow[]> {
    const where = opts.includeDeleted ? "WHERE user_id = ?" : "WHERE user_id = ? AND deleted_at IS NULL";
    const rows = (await this.db
      .prepare(`SELECT * FROM memberships ${where} ORDER BY created_at ASC`)
      .all(userId)) as MembershipRow[];
    return rows;
  }

  async get(userId: string, teamId: string, opts: ListOptions = {}): Promise<MembershipRow | null> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM memberships WHERE user_id = ? AND team_id = ?"
      : "SELECT * FROM memberships WHERE user_id = ? AND team_id = ? AND deleted_at IS NULL";
    const row = (await this.db.prepare(sql).get(userId, teamId)) as MembershipRow | undefined;
    return row ?? null;
  }

  async add(userId: string, teamId: string, role: MembershipRole): Promise<MembershipRow> {
    const existing = await this.get(userId, teamId);
    if (existing) {
      if (existing.role !== role) {
        await this.db
          .prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND team_id = ? AND deleted_at IS NULL")
          .run(role, userId, teamId);
        return (await this.get(userId, teamId))!;
      }
      return existing;
    }
    const id = `m-${randomBytes(6).toString("hex")}`;
    await this.db
      .prepare("INSERT INTO memberships (id, user_id, team_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, userId, teamId, role, now());
    return (await this.get(userId, teamId))!;
  }

  /**
   * Soft-remove: sets `deleted_at` on the live membership row (if any) and
   * records `deleted_by` with the caller's user id (null for system /
   * unauthenticated paths). Returns `true` if a row was affected OR if the
   * membership was already soft-deleted (idempotent -- the second call does
   * NOT overwrite the audit fields). Returns `false` if no such membership
   * ever existed.
   */
  async softRemove(userId: string, teamId: string, deletedBy: string | null = null): Promise<boolean> {
    const row = (await this.db
      .prepare("SELECT deleted_at FROM memberships WHERE user_id = ? AND team_id = ?")
      .get(userId, teamId)) as { deleted_at: string | null } | undefined;
    if (!row) return false;
    if (row.deleted_at) return true;
    const res = await this.db
      .prepare(
        "UPDATE memberships SET deleted_at = ?, deleted_by = ? WHERE user_id = ? AND team_id = ? AND deleted_at IS NULL",
      )
      .run(now(), deletedBy, userId, teamId);
    return res.changes > 0;
  }

  async restore(userId: string, teamId: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE memberships SET deleted_at = NULL, deleted_by = NULL WHERE user_id = ? AND team_id = ? AND deleted_at IS NOT NULL",
      )
      .run(userId, teamId);
    return res.changes > 0;
  }

  async setRole(userId: string, teamId: string, role: MembershipRole): Promise<MembershipRow | null> {
    await this.db
      .prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND team_id = ? AND deleted_at IS NULL")
      .run(role, userId, teamId);
    return this.get(userId, teamId);
  }

  /**
   * Cascade helper -- soft-delete every membership for a given team.
   * Used when a team is itself soft-deleted (which in turn cascades from
   * a tenant soft-delete). `deletedBy` is propagated so the cascade carries
   * the upstream actor's identity.
   */
  async softRemoveByTeam(teamId: string, deletedBy: string | null = null): Promise<void> {
    await this.db
      .prepare("UPDATE memberships SET deleted_at = ?, deleted_by = ? WHERE team_id = ? AND deleted_at IS NULL")
      .run(now(), deletedBy, teamId);
  }

  /**
   * Cascade helper -- soft-delete every membership for a given user.
   * Used when a user is soft-deleted.
   */
  async softRemoveByUser(userId: string, deletedBy: string | null = null): Promise<void> {
    await this.db
      .prepare("UPDATE memberships SET deleted_at = ?, deleted_by = ? WHERE user_id = ? AND deleted_at IS NULL")
      .run(now(), deletedBy, userId);
  }
}
