/**
 * DB-backed resource store for control plane mode.
 *
 * Stores YAML resource definitions (agents, flows, skills, recipes, runtimes)
 * in the database with tenant_id scoping. Same interface as the file-backed
 * stores, but backed by a `resource_definitions` table.
 *
 * Local mode uses file-backed stores. Control plane uses this.
 */

import type { IDatabase } from "../database/index.js";
import YAML from "yaml";

// ── Schema ─────────────────────────────────────────────────────────────────

export async function initResourceDefinitionsTable(db: IDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS resource_definitions (
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (name, kind, tenant_id)
    )
  `);
}

// ── Types ──────────────────────────────────────────────────────────────────

export type ResourceKind = "agent" | "flow" | "skill" | "recipe" | "runtime";

interface ResourceRow {
  name: string;
  kind: string;
  content: string;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

// ── Generic DB resource store ──────────────────────────────────────────────

export class DbResourceStore<T extends { name: string }> {
  private tenantId: string = "default";

  constructor(
    private db: IDatabase,
    private kind: ResourceKind,
    private defaults: Omit<T, "name">,
  ) {}

  setTenant(id: string): void {
    this.tenantId = id;
  }
  getTenant(): string {
    return this.tenantId;
  }

  async list(): Promise<T[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM resource_definitions WHERE kind = ? AND tenant_id = ? ORDER BY name")
      .all(this.kind, this.tenantId)) as ResourceRow[];
    return rows.map((r) => this.rowToResource(r));
  }

  async get(name: string): Promise<T | null> {
    const row = (await this.db
      .prepare("SELECT * FROM resource_definitions WHERE name = ? AND kind = ? AND tenant_id = ?")
      .get(name, this.kind, this.tenantId)) as ResourceRow | undefined;
    return row ? this.rowToResource(row) : null;
  }

  async save(name: string, resource: T): Promise<void> {
    const ts = new Date().toISOString();
    // Strip synthetic fields before serialising. `_source` / `_path` are
    // markers the file-backed store adds so callers can see which tier a
    // resource came from; they have no business in the DB row.
    const { _source: _s, _path: _p, ...data } = resource as T & { _source?: string; _path?: string };
    void _s;
    void _p;
    const content = YAML.stringify(data);

    await this.db
      .prepare(
        `
      INSERT INTO resource_definitions (name, kind, content, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (name, kind, tenant_id) DO UPDATE SET content = ?, updated_at = ?
    `,
      )
      .run(name, this.kind, content, this.tenantId, ts, ts, content, ts);
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM resource_definitions WHERE name = ? AND kind = ? AND tenant_id = ?")
      .run(name, this.kind, this.tenantId);
    return result.changes > 0;
  }

  /** Export all resources as YAML (for file-backed export). */
  async exportAll(): Promise<Array<{ name: string; yaml: string }>> {
    const all = await this.list();
    return all.map((r) => {
      const rec = r as T & { name: string; _source?: string; _path?: string };
      const { _source: _s, _path: _p, ...data } = rec;
      void _s;
      void _p;
      return { name: rec.name, yaml: YAML.stringify(data) };
    });
  }

  /** Import resources from YAML (for control plane import from local files). */
  async importAll(resources: Array<{ name: string; yaml: string }>): Promise<number> {
    let count = 0;
    for (const { name, yaml } of resources) {
      const parsed = YAML.parse(yaml);
      if (parsed) {
        await this.save(name, { ...this.defaults, ...parsed, name } as T);
        count++;
      }
    }
    return count;
  }

  private rowToResource(row: ResourceRow): T {
    const parsed = YAML.parse(row.content) ?? {};
    return { ...this.defaults, ...parsed, name: row.name, _source: "db" } as T;
  }
}
