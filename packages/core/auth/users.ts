/**
 * UserManager -- CRUD for user identities, keyed by email.
 *
 * Authentication (password, OIDC, JWT verification, ...) is out of scope.
 * Users here are durable identities that memberships hang off. An auth
 * layer that has just validated a credential calls `upsertByEmail` to
 * create-or-fetch the user without worrying about races.
 *
 * Mirrors `TenantPolicyManager`: lazy `ensureSchema()`, async end-to-end.
 */

import type { DatabaseAdapter } from "../database/index.js";
import { UserRepository, type ListOptions, type UserRow } from "../repositories/users.js";
import { MembershipRepository } from "../repositories/memberships.js";
import { logDebug } from "../observability/structured-log.js";

export type User = UserRow;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertEmail(email: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new Error(`Invalid email '${email}'`);
  }
}

export class UserManager {
  private _initialized: Promise<void> | null = null;
  private _repo: UserRepository;
  private _memberships: MembershipRepository;

  constructor(private db: DatabaseAdapter) {
    this._repo = new UserRepository(db);
    this._memberships = new MembershipRepository(db);
  }

  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = (async () => {
      try {
        await this.db.exec(
          `CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            name TEXT,
            deleted_at TEXT,
            deleted_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
        );
      } catch {
        logDebug("general", "users table exists");
      }
    })();
    return this._initialized;
  }

  async list(opts: ListOptions = {}): Promise<User[]> {
    await this.ensureSchema();
    return this._repo.list(opts);
  }

  async get(idOrEmail: string, opts: ListOptions = {}): Promise<User | null> {
    await this.ensureSchema();
    const byId = await this._repo.get(idOrEmail, opts);
    if (byId) return byId;
    return this._repo.getByEmail(idOrEmail, opts);
  }

  async create(opts: { email: string; name?: string | null }): Promise<User> {
    await this.ensureSchema();
    assertEmail(opts.email);
    const existing = await this._repo.getByEmail(opts.email);
    if (existing) throw new Error(`User with email '${opts.email}' already exists`);
    return this._repo.create(opts);
  }

  async upsertByEmail(opts: { email: string; name?: string | null }): Promise<User> {
    await this.ensureSchema();
    assertEmail(opts.email);
    return this._repo.upsertByEmail(opts);
  }

  /**
   * Soft-delete a user and cascade to their memberships inside a
   * transaction. Idempotent.
   *
   * `actingUserId` is the id of the caller performing the delete (from
   * `ctx.userId`); it's recorded in `deleted_by` on both the user row AND
   * every cascaded membership. `null` (the default) means "system" deleter.
   *
   * Note: `actingUserId` is distinct from the `id` being deleted -- a user
   * can't be both the target and the actor unless an admin is revoking
   * their own account.
   */
  async delete(id: string, actingUserId: string | null = null): Promise<boolean> {
    await this.ensureSchema();
    return this.db.transaction(async () => {
      const ok = await this._repo.softDelete(id, actingUserId);
      if (!ok) return false;
      await this._memberships.softRemoveByUser(id, actingUserId);
      return true;
    });
  }

  async restore(id: string): Promise<boolean> {
    await this.ensureSchema();
    return this._repo.restore(id);
  }
}
