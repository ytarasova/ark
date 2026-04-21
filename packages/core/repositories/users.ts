/**
 * UserRepository -- SQL adapter for the `users` table.
 *
 * The table is created by migration 003. Authentication details (password,
 * OIDC provider, etc.) are intentionally NOT on this table -- users here
 * are just durable identities keyed by email. `upsertByEmail` is the
 * primitive an auth layer calls when it sees a new JWT.
 */

import type { IDatabase } from "../database/index.js";
import { randomBytes } from "crypto";
import { now } from "../util/time.js";

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  updated_at: string;
}

export class UserRepository {
  constructor(private db: IDatabase) {}

  async list(): Promise<UserRow[]> {
    const rows = (await this.db.prepare("SELECT * FROM users ORDER BY email ASC").all()) as UserRow[];
    return rows;
  }

  async get(id: string): Promise<UserRow | null> {
    const row = (await this.db.prepare("SELECT * FROM users WHERE id = ?").get(id)) as UserRow | undefined;
    return row ?? null;
  }

  async getByEmail(email: string): Promise<UserRow | null> {
    const row = (await this.db.prepare("SELECT * FROM users WHERE email = ?").get(email)) as UserRow | undefined;
    return row ?? null;
  }

  async create(u: { email: string; name?: string | null }): Promise<UserRow> {
    const id = `u-${randomBytes(6).toString("hex")}`;
    const ts = now();
    await this.db
      .prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, u.email, u.name ?? null, ts, ts);
    return (await this.get(id))!;
  }

  /**
   * Idempotent: if a row with this email exists, return it (name is
   * updated if provided + different). Otherwise insert a new row. Safe to
   * call from an auth layer that has just verified a JWT.
   */
  async upsertByEmail(u: { email: string; name?: string | null }): Promise<UserRow> {
    const existing = await this.getByEmail(u.email);
    if (existing) {
      if (u.name !== undefined && u.name !== existing.name) {
        await this.db
          .prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?")
          .run(u.name ?? null, now(), existing.id);
        return (await this.get(existing.id))!;
      }
      return existing;
    }
    return this.create(u);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return res.changes > 0;
  }
}
