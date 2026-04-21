/**
 * TenantRepository -- thin SQL adapter for the `tenants` table.
 *
 * The table is created by migration 003 (`003_tenants_teams.ts`). Callers
 * typically reach it through `TenantManager` (packages/core/auth/tenants.ts)
 * which wraps CRUD with the lazy `ensureSchema()` guard. This repository is
 * the direct SQL layer used by that manager.
 */

import type { IDatabase } from "../database/index.js";
import { now } from "../util/time.js";

export type TenantStatus = "active" | "suspended" | "archived";

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  created_at: string;
  updated_at: string;
}

const COLUMNS = new Set(["slug", "name", "status", "updated_at"]);

export class TenantRepository {
  constructor(private db: IDatabase) {}

  async list(): Promise<TenantRow[]> {
    const rows = (await this.db.prepare("SELECT * FROM tenants ORDER BY slug ASC").all()) as TenantRow[];
    return rows;
  }

  async get(id: string): Promise<TenantRow | null> {
    const row = (await this.db.prepare("SELECT * FROM tenants WHERE id = ?").get(id)) as TenantRow | undefined;
    return row ?? null;
  }

  async getBySlug(slug: string): Promise<TenantRow | null> {
    const row = (await this.db.prepare("SELECT * FROM tenants WHERE slug = ?").get(slug)) as TenantRow | undefined;
    return row ?? null;
  }

  async create(t: { id: string; slug: string; name: string; status?: TenantStatus }): Promise<TenantRow> {
    const ts = now();
    await this.db
      .prepare("INSERT INTO tenants (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.id, t.slug, t.name, t.status ?? "active", ts, ts);
    return (await this.get(t.id))!;
  }

  async update(id: string, fields: Partial<Pick<TenantRow, "slug" | "name" | "status">>): Promise<TenantRow | null> {
    const updates: string[] = ["updated_at = ?"];
    const values: any[] = [now()];
    for (const [key, value] of Object.entries(fields)) {
      if (!COLUMNS.has(key)) continue;
      updates.push(`${key} = ?`);
      values.push(value);
    }
    values.push(id);
    await this.db.prepare(`UPDATE tenants SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  /**
   * Hard-delete a tenant. FKs on `teams` + `memberships` cascade. Session
   * and compute rows for this tenant are NOT touched -- removing them here
   * would be too destructive; see migration 003 for the rationale.
   */
  async delete(id: string): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM tenants WHERE id = ?").run(id);
    return res.changes > 0;
  }
}
