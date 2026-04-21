/**
 * TenantManager -- CRUD + status transitions for tenants.
 *
 * Tenants are the isolation boundary. Every session / compute / event /
 * etc. already carries a `tenant_id` string; this manager makes that a
 * first-class entity with a slug, a human name, and a lifecycle status
 * ("active" | "suspended" | "archived").
 *
 * Mirrors `TenantPolicyManager`: lazy `ensureSchema()` guarded by a cached
 * promise, every public method async, no sync ctor work.
 *
 * NOTE on `delete`: it hard-cascades teams + memberships (via FK in
 * migration 003) but leaves sessions + computes owned by the tenant
 * behind. Deleting those is too destructive to do implicitly -- callers
 * who really want a full wipe should delete the downstream rows first.
 */

import type { IDatabase } from "../database/index.js";
import { randomBytes } from "crypto";
import { TenantRepository, type TenantRow, type TenantStatus } from "../repositories/tenants.js";
import { logDebug } from "../observability/structured-log.js";

export type Tenant = TenantRow;
export type { TenantStatus };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid slug '${slug}' -- must be kebab-case, 1-64 chars, start + end alphanumeric`);
  }
}

export class TenantManager {
  private _initialized: Promise<void> | null = null;
  private _repo: TenantRepository;

  constructor(private db: IDatabase) {
    this._repo = new TenantRepository(db);
  }

  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = (async () => {
      try {
        await this.db.exec(
          `CREATE TABLE IF NOT EXISTS tenants (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
        );
      } catch {
        logDebug("general", "tenants table exists");
      }
    })();
    return this._initialized;
  }

  async list(): Promise<Tenant[]> {
    await this.ensureSchema();
    return this._repo.list();
  }

  async get(idOrSlug: string): Promise<Tenant | null> {
    await this.ensureSchema();
    const byId = await this._repo.get(idOrSlug);
    if (byId) return byId;
    return this._repo.getBySlug(idOrSlug);
  }

  async create(opts: { slug: string; name: string; id?: string; status?: TenantStatus }): Promise<Tenant> {
    await this.ensureSchema();
    assertSlug(opts.slug);
    const existing = await this._repo.getBySlug(opts.slug);
    if (existing) throw new Error(`Tenant with slug '${opts.slug}' already exists`);
    const id = opts.id ?? `t-${randomBytes(6).toString("hex")}`;
    return this._repo.create({ id, slug: opts.slug, name: opts.name, status: opts.status });
  }

  async update(id: string, fields: Partial<Pick<Tenant, "slug" | "name" | "status">>): Promise<Tenant | null> {
    await this.ensureSchema();
    if (fields.slug) assertSlug(fields.slug);
    return this._repo.update(id, fields);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureSchema();
    return this._repo.delete(id);
  }

  async setStatus(id: string, status: TenantStatus): Promise<Tenant | null> {
    await this.ensureSchema();
    return this._repo.update(id, { status });
  }
}
