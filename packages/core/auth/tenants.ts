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
 * Soft-delete: `delete(id)` is now a soft-delete (see migration 004).
 * Hard DELETE is gone -- we set `deleted_at` so downstream rows keep their
 * referential integrity and the audit trail is preserved. The old cascade
 * via FK `ON DELETE CASCADE` is replaced by an explicit manager-layer
 * cascade that soft-deletes child teams + memberships inside one txn.
 */

import type { IDatabase } from "../database/index.js";
import { randomBytes } from "crypto";
import { TenantRepository, type ListOptions, type TenantRow, type TenantStatus } from "../repositories/tenants.js";
export type { ListOptions } from "../repositories/tenants.js";
import { TeamRepository } from "../repositories/teams.js";
import { MembershipRepository } from "../repositories/memberships.js";
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
  private _teams: TeamRepository;
  private _memberships: MembershipRepository;

  constructor(private db: IDatabase) {
    this._repo = new TenantRepository(db);
    this._teams = new TeamRepository(db);
    this._memberships = new MembershipRepository(db);
  }

  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = (async () => {
      try {
        const ddl =
          "CREATE TABLE IF NOT EXISTS tenants (" +
          "id TEXT PRIMARY KEY, " +
          "slug TEXT NOT NULL, " +
          "name TEXT NOT NULL, " +
          "status TEXT NOT NULL DEFAULT 'active', " +
          "deleted_at TEXT, " +
          "created_at TEXT NOT NULL, " +
          "updated_at TEXT NOT NULL)";
        await this.db.exec(ddl);
      } catch {
        logDebug("general", "tenants table exists");
      }
    })();
    return this._initialized;
  }

  async list(opts: ListOptions = {}): Promise<Tenant[]> {
    await this.ensureSchema();
    return this._repo.list(opts);
  }

  async get(idOrSlug: string, opts: ListOptions = {}): Promise<Tenant | null> {
    await this.ensureSchema();
    const byId = await this._repo.get(idOrSlug, opts);
    if (byId) return byId;
    return this._repo.getBySlug(idOrSlug, opts);
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

  /**
   * Soft-delete a tenant and cascade to its teams + memberships inside a
   * single transaction. Idempotent -- calling on an already-soft-deleted
   * tenant is a no-op and returns `true`.
   *
   * TODO(agent-1-ctx): admin handler should pass ctx.userId to record who
   * deleted the entity (audit trail). Once ctx wiring lands we add a
   * `deleted_by` column and populate it here.
   */
  async delete(id: string): Promise<boolean> {
    await this.ensureSchema();
    return this.db.transaction(async () => {
      const ok = await this._repo.softDelete(id);
      if (!ok) return false;
      // Cascade: soft-delete every team in the tenant and every membership
      // of every team. We drive this from the manager because the FK
      // `ON DELETE CASCADE` only fires on hard DELETE.
      const teams = await this._teams.listByTenant(id);
      for (const team of teams) {
        await this._memberships.softRemoveByTeam(team.id);
      }
      await this._teams.softDeleteByTenant(id);
      return true;
    });
  }

  /**
   * Restore a soft-deleted tenant. Does NOT auto-restore child teams or
   * memberships -- an admin restores those explicitly if they want the
   * old shape back.
   */
  async restore(id: string): Promise<boolean> {
    await this.ensureSchema();
    return this._repo.restore(id);
  }

  async setStatus(id: string, status: TenantStatus): Promise<Tenant | null> {
    await this.ensureSchema();
    return this._repo.update(id, { status });
  }
}
