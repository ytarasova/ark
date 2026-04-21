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
  // Sync-access cache keyed by `<tenantId>::<name>`. Populated lazily on
  // every `list()` call + every `save()`/`delete()`, and used by the sync
  // `get()` path below. Without this cache, hosted-mode callers that use
  // the sync FlowStore/AgentStore contract (see
  // `state/flow.ts::getFirstStage`) receive a pending Promise which they
  // treat as a FlowDefinition, deref `.stages`, and silently get
  // `undefined` -- which is exactly how single-stage `e2e-noop` flows used
  // to hang forever at `status: pending`.
  private syncCache: Map<string, T | null> = new Map();

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

  private cacheKey(name: string): string {
    return `${this.tenantId}::${name}`;
  }

  async list(): Promise<T[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM resource_definitions WHERE kind = ? AND tenant_id = ? ORDER BY name")
      .all(this.kind, this.tenantId)) as ResourceRow[];
    const resources = rows.map((r) => this.rowToResource(r));
    // Re-seed sync cache on every list so subsequent sync `get()` calls
    // see the latest server-side view.
    for (const r of resources) {
      this.syncCache.set(this.cacheKey(r.name), r);
    }
    return resources;
  }

  /**
   * Return a resource by name. The method signature is
   * `T | null | Promise<T | null>` so both async and sync callers work --
   * async paths `await` as before, sync paths (`state/flow.ts`) consult
   * the in-memory cache populated by `list()` / `save()`.
   *
   * Sync callers that miss the cache get `null` and should trigger an
   * async rehydrate out-of-band. In practice this is fine because every
   * hot sync caller runs after a `list()` or a recent `save()`.
   */
  get(name: string): T | null | Promise<T | null> {
    // Fast path: cache hit. Use `has` so we distinguish "not loaded" from
    // "loaded and confirmed absent" (the second gets cached as null to
    // avoid thrashing the DB on repeated lookups of a missing name).
    const key = this.cacheKey(name);
    if (this.syncCache.has(key)) {
      return this.syncCache.get(key) ?? null;
    }
    // Slow path: async query, populates the cache for next time. Sync
    // callers see `Promise<null>` this round and null on the next
    // re-entry once the cache is populated; this matches how `flow/read`
    // warms the cache on the first RPC call.
    return this.getAsync(name);
  }

  private async getAsync(name: string): Promise<T | null> {
    const row = (await this.db
      .prepare("SELECT * FROM resource_definitions WHERE name = ? AND kind = ? AND tenant_id = ?")
      .get(name, this.kind, this.tenantId)) as ResourceRow | undefined;
    const resource = row ? this.rowToResource(row) : null;
    this.syncCache.set(this.cacheKey(name), resource);
    return resource;
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

    // Keep the sync cache coherent with the row we just persisted.
    this.syncCache.set(this.cacheKey(name), { ...this.defaults, ...(resource as object), name, _source: "db" } as T);
  }

  async delete(name: string): Promise<boolean> {
    const result = await this.db
      .prepare("DELETE FROM resource_definitions WHERE name = ? AND kind = ? AND tenant_id = ?")
      .run(name, this.kind, this.tenantId);
    // Cache the known-absent state so a follow-up sync `get` doesn't
    // resurrect the row via a stale Map entry.
    this.syncCache.set(this.cacheKey(name), null);
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
