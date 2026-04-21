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

import type { IDatabase } from "../database/index.js";
import { UserRepository, type UserRow } from "../repositories/users.js";
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

  constructor(private db: IDatabase) {
    this._repo = new UserRepository(db);
  }

  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = (async () => {
      try {
        await this.db.exec(
          `CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            name TEXT,
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

  async list(): Promise<User[]> {
    await this.ensureSchema();
    return this._repo.list();
  }

  async get(idOrEmail: string): Promise<User | null> {
    await this.ensureSchema();
    const byId = await this._repo.get(idOrEmail);
    if (byId) return byId;
    return this._repo.getByEmail(idOrEmail);
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

  async delete(id: string): Promise<boolean> {
    await this.ensureSchema();
    return this._repo.delete(id);
  }
}
