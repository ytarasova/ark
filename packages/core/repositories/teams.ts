/**
 * TeamRepository -- SQL adapter for the `teams` table.
 *
 * Teams live inside a tenant -- `(tenant_id, slug)` is unique. The table
 * is created by migration 003 with an FK to `tenants(id) ON DELETE
 * CASCADE`, so deleting a tenant wipes its teams (and the memberships
 * table cascades off teams in turn).
 */

import type { IDatabase } from "../database/index.js";
import { now } from "../util/time.js";

export interface TeamRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = new Set(["slug", "name", "description", "updated_at"]);

export class TeamRepository {
  constructor(private db: IDatabase) {}

  async listByTenant(tenantId: string): Promise<TeamRow[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM teams WHERE tenant_id = ? ORDER BY slug ASC")
      .all(tenantId)) as TeamRow[];
    return rows;
  }

  async get(id: string): Promise<TeamRow | null> {
    const row = (await this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id)) as TeamRow | undefined;
    return row ?? null;
  }

  async create(t: {
    id: string;
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
  }): Promise<TeamRow> {
    const ts = now();
    await this.db
      .prepare(
        "INSERT INTO teams (id, tenant_id, slug, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.id, t.tenant_id, t.slug, t.name, t.description ?? null, ts, ts);
    return (await this.get(t.id))!;
  }

  async update(id: string, fields: Partial<Pick<TeamRow, "slug" | "name" | "description">>): Promise<TeamRow | null> {
    const updates: string[] = ["updated_at = ?"];
    const values: any[] = [now()];
    for (const [key, value] of Object.entries(fields)) {
      if (!COLUMNS.has(key)) continue;
      updates.push(`${key} = ?`);
      values.push(value ?? null);
    }
    values.push(id);
    await this.db.prepare(`UPDATE teams SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.prepare("DELETE FROM teams WHERE id = ?").run(id);
    return res.changes > 0;
  }
}
