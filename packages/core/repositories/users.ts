/**
 * UserRepository -- SQL adapter for the `users` table.
 *
 * The table is created by migration 003. `deleted_at` is added in 004
 * so users are soft-deletable; email uniqueness is enforced by a partial
 * unique index scoped to live rows. Authentication details (password,
 * OIDC provider) still live elsewhere -- users here are durable identities.
 */

import type { IDatabase } from "../database/index.js";
import { randomBytes } from "crypto";
import { now } from "../util/time.js";

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

export class UserRepository {
  constructor(private db: IDatabase) {}

  async list(opts: ListOptions = {}): Promise<UserRow[]> {
    const where = opts.includeDeleted ? "" : "WHERE deleted_at IS NULL";
    const rows = (await this.db.prepare(`SELECT * FROM users ${where} ORDER BY email ASC`).all()) as UserRow[];
    return rows;
  }

  async get(id: string, opts: ListOptions = {}): Promise<UserRow | null> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM users WHERE id = ?"
      : "SELECT * FROM users WHERE id = ? AND deleted_at IS NULL";
    const row = (await this.db.prepare(sql).get(id)) as UserRow | undefined;
    return row ?? null;
  }

  async getByEmail(email: string, opts: ListOptions = {}): Promise<UserRow | null> {
    const sql = opts.includeDeleted
      ? "SELECT * FROM users WHERE email = ?"
      : "SELECT * FROM users WHERE email = ? AND deleted_at IS NULL";
    const row = (await this.db.prepare(sql).get(email)) as UserRow | undefined;
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
   * Idempotent: if a live row with this email exists, return it (name is
   * updated if provided + different). Otherwise insert a new row. Safe to
   * call from an auth layer that has just verified a JWT. Does NOT
   * resurrect soft-deleted users -- call `restore(id)` explicitly for that.
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

  async softDelete(id: string, userId: string | null = null): Promise<boolean> {
    const existing = (await this.db.prepare("SELECT deleted_at FROM users WHERE id = ?").get(id)) as
      | { deleted_at: string | null }
      | undefined;
    if (!existing) return false;
    if (existing.deleted_at) return true;
    const ts = now();
    const res = await this.db
      .prepare("UPDATE users SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
      .run(ts, userId, ts, id);
    return res.changes > 0;
  }

  async restore(id: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        "UPDATE users SET deleted_at = NULL, deleted_by = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL",
      )
      .run(now(), id);
    return res.changes > 0;
  }
}
