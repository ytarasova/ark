/**
 * MembershipRepository -- SQL adapter for the `memberships` table.
 *
 * A membership binds a user to a team with a flat role string
 * ("owner" | "admin" | "member" | "viewer"). Authorization decisions are
 * made elsewhere (tenant_policies + future policy code). Role is NOT a
 * permissions matrix -- keep it simple.
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
  created_at: string;
}

export interface MembershipWithUser extends MembershipRow {
  email: string;
  name: string | null;
}

export class MembershipRepository {
  constructor(private db: IDatabase) {}

  async listByTeam(teamId: string): Promise<MembershipWithUser[]> {
    const rows = (await this.db
      .prepare(
        `SELECT m.id, m.user_id, m.team_id, m.role, m.created_at, u.email, u.name
         FROM memberships m
         INNER JOIN users u ON u.id = m.user_id
         WHERE m.team_id = ?
         ORDER BY u.email ASC`,
      )
      .all(teamId)) as MembershipWithUser[];
    return rows;
  }

  async listByUser(userId: string): Promise<MembershipRow[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM memberships WHERE user_id = ? ORDER BY created_at ASC")
      .all(userId)) as MembershipRow[];
    return rows;
  }

  async get(userId: string, teamId: string): Promise<MembershipRow | null> {
    const row = (await this.db
      .prepare("SELECT * FROM memberships WHERE user_id = ? AND team_id = ?")
      .get(userId, teamId)) as MembershipRow | undefined;
    return row ?? null;
  }

  async add(userId: string, teamId: string, role: MembershipRole): Promise<MembershipRow> {
    const existing = await this.get(userId, teamId);
    if (existing) {
      if (existing.role !== role) {
        await this.db
          .prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND team_id = ?")
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

  async remove(userId: string, teamId: string): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM memberships WHERE user_id = ? AND team_id = ?").run(userId, teamId);
    return res.changes > 0;
  }

  async setRole(userId: string, teamId: string, role: MembershipRole): Promise<MembershipRow | null> {
    await this.db
      .prepare("UPDATE memberships SET role = ? WHERE user_id = ? AND team_id = ?")
      .run(role, userId, teamId);
    return this.get(userId, teamId);
  }
}
