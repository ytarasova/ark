/**
 * TeamManager -- CRUD for teams inside a tenant + membership management.
 *
 * Mirrors `TenantPolicyManager` / `TenantManager`: lazy `ensureSchema()`,
 * async end-to-end. `(tenant_id, slug)` is unique per tenant; roles are a
 * flat enum string (`owner`/`admin`/`member`/`viewer`) -- authorization
 * policies live in `tenant_policies`, not here.
 */

import type { IDatabase } from "../database/index.js";
import { randomBytes } from "crypto";
import { TeamRepository, type TeamRow } from "../repositories/teams.js";
import {
  MembershipRepository,
  type MembershipRole,
  type MembershipRow,
  type MembershipWithUser,
} from "../repositories/memberships.js";
import { logDebug } from "../observability/structured-log.js";

export type Team = TeamRow;
export type { MembershipRole, MembershipRow, MembershipWithUser };

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;
const VALID_ROLES: MembershipRole[] = ["owner", "admin", "member", "viewer"];

function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new Error(`Invalid slug '${slug}' -- must be kebab-case, 1-64 chars, start + end alphanumeric`);
  }
}

function assertRole(role: string): asserts role is MembershipRole {
  if (!VALID_ROLES.includes(role as MembershipRole)) {
    throw new Error(`Invalid role '${role}' -- must be one of ${VALID_ROLES.join(", ")}`);
  }
}

export class TeamManager {
  private _initialized: Promise<void> | null = null;
  private _teams: TeamRepository;
  private _memberships: MembershipRepository;

  constructor(private db: IDatabase) {
    this._teams = new TeamRepository(db);
    this._memberships = new MembershipRepository(db);
  }

  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = (async () => {
      try {
        await this.db.exec(
          `CREATE TABLE IF NOT EXISTS teams (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (tenant_id, slug)
          )`,
        );
        await this.db.exec(
          `CREATE TABLE IF NOT EXISTS memberships (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            team_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'member',
            created_at TEXT NOT NULL,
            UNIQUE (user_id, team_id)
          )`,
        );
      } catch {
        logDebug("general", "teams/memberships tables exist");
      }
    })();
    return this._initialized;
  }

  async listByTenant(tenantId: string): Promise<Team[]> {
    await this.ensureSchema();
    return this._teams.listByTenant(tenantId);
  }

  async get(teamId: string): Promise<Team | null> {
    await this.ensureSchema();
    return this._teams.get(teamId);
  }

  async create(opts: {
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
    id?: string;
  }): Promise<Team> {
    await this.ensureSchema();
    assertSlug(opts.slug);
    const existing = (await this._teams.listByTenant(opts.tenant_id)).find((t) => t.slug === opts.slug);
    if (existing) throw new Error(`Team '${opts.slug}' already exists in tenant '${opts.tenant_id}'`);
    const id = opts.id ?? `tm-${randomBytes(6).toString("hex")}`;
    return this._teams.create({
      id,
      tenant_id: opts.tenant_id,
      slug: opts.slug,
      name: opts.name,
      description: opts.description ?? null,
    });
  }

  async update(teamId: string, fields: Partial<Pick<Team, "slug" | "name" | "description">>): Promise<Team | null> {
    await this.ensureSchema();
    if (fields.slug) assertSlug(fields.slug);
    return this._teams.update(teamId, fields);
  }

  async delete(teamId: string): Promise<boolean> {
    await this.ensureSchema();
    return this._teams.delete(teamId);
  }

  async listMembers(teamId: string): Promise<MembershipWithUser[]> {
    await this.ensureSchema();
    return this._memberships.listByTeam(teamId);
  }

  async addMember(teamId: string, userId: string, role: MembershipRole = "member"): Promise<MembershipRow> {
    await this.ensureSchema();
    assertRole(role);
    return this._memberships.add(userId, teamId, role);
  }

  async removeMember(teamId: string, userId: string): Promise<boolean> {
    await this.ensureSchema();
    return this._memberships.remove(userId, teamId);
  }

  async setRole(teamId: string, userId: string, role: MembershipRole): Promise<MembershipRow | null> {
    await this.ensureSchema();
    assertRole(role);
    return this._memberships.setRole(userId, teamId, role);
  }
}
