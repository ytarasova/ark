/**
 * Worker Registry -- tracks available compute workers for the hosted
 * control plane. Workers (ArkD instances) register themselves, send
 * heartbeats, and are pruned when stale.
 *
 * State is persisted in a `workers` SQL table so it survives restarts.
 *
 * Every method is async because IDatabase is async. The constructor no
 * longer performs DDL synchronously; instead, `ensureSchema()` runs lazily
 * on first use.
 */

import type { IDatabase } from "../database/index.js";

export interface WorkerNode {
  id: string;
  url: string;
  status: "online" | "offline" | "draining";
  capacity: number;
  active_sessions: number;
  last_heartbeat: string;
  compute_name: string | null;
  tenant_id: string | null;
  metadata: Record<string, unknown>;
}

interface WorkerRow {
  id: string;
  url: string;
  status: WorkerNode["status"];
  capacity: number;
  active_sessions: number;
  last_heartbeat: string;
  compute_name: string | null;
  tenant_id: string | null;
  metadata: string | Record<string, unknown> | null;
}

export class WorkerRegistry {
  private _initialized: Promise<void> | null = null;

  constructor(private db: IDatabase) {}

  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS workers (
          id TEXT PRIMARY KEY,
          url TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'online',
          capacity INTEGER NOT NULL DEFAULT 5,
          active_sessions INTEGER NOT NULL DEFAULT 0,
          last_heartbeat TEXT NOT NULL,
          compute_name TEXT,
          tenant_id TEXT,
          metadata TEXT DEFAULT '{}'
        )`,
      )
      .run()
      .then(() => undefined);
    return this._initialized;
  }

  /** Register a new worker (or re-register an existing one). */
  async register(worker: Omit<WorkerNode, "status" | "active_sessions" | "last_heartbeat">): Promise<void> {
    await this.ensureSchema();
    const now = new Date().toISOString();
    const meta = JSON.stringify(worker.metadata ?? {});
    // Upsert: if worker exists, update its fields and mark online
    const existing = await this.db.prepare("SELECT id FROM workers WHERE id = ?").get(worker.id);
    if (existing) {
      await this.db
        .prepare(
          `UPDATE workers SET url = ?, capacity = ?, compute_name = ?, tenant_id = ?,
         metadata = ?, status = 'online', last_heartbeat = ? WHERE id = ?`,
        )
        .run(worker.url, worker.capacity, worker.compute_name ?? null, worker.tenant_id ?? null, meta, now, worker.id);
    } else {
      await this.db
        .prepare(
          `INSERT INTO workers (id, url, status, capacity, active_sessions, last_heartbeat,
         compute_name, tenant_id, metadata) VALUES (?, ?, 'online', ?, 0, ?, ?, ?, ?)`,
        )
        .run(worker.id, worker.url, worker.capacity, now, worker.compute_name ?? null, worker.tenant_id ?? null, meta);
    }
  }

  /** Update heartbeat timestamp for a worker. Marks it online if it was offline. */
  async heartbeat(workerId: string): Promise<void> {
    await this.ensureSchema();
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE workers SET last_heartbeat = ?, status = 'online' WHERE id = ?").run(now, workerId);
  }

  /** Remove a worker from the registry. */
  async deregister(workerId: string): Promise<void> {
    await this.ensureSchema();
    await this.db.prepare("DELETE FROM workers WHERE id = ?").run(workerId);
  }

  /** List workers, optionally filtered by status and/or tenant. */
  async list(opts?: { status?: string; tenantId?: string }): Promise<WorkerNode[]> {
    await this.ensureSchema();
    let sql = "SELECT * FROM workers WHERE 1=1";
    const params: unknown[] = [];

    if (opts?.status) {
      sql += " AND status = ?";
      params.push(opts.status);
    }
    if (opts?.tenantId) {
      sql += " AND (tenant_id = ? OR tenant_id IS NULL)";
      params.push(opts.tenantId);
    }

    sql += " ORDER BY active_sessions ASC";
    const rows = (await this.db.prepare(sql).all(...params)) as WorkerRow[];
    return rows.map((r) => this.hydrateRow(r));
  }

  /** Get available (online, not at capacity) workers, optionally filtered. */
  async getAvailable(opts?: { tenantId?: string; computeName?: string }): Promise<WorkerNode[]> {
    await this.ensureSchema();
    let sql = "SELECT * FROM workers WHERE status = 'online' AND active_sessions < capacity";
    const params: unknown[] = [];

    if (opts?.tenantId) {
      sql += " AND (tenant_id = ? OR tenant_id IS NULL)";
      params.push(opts.tenantId);
    }
    if (opts?.computeName) {
      sql += " AND compute_name = ?";
      params.push(opts.computeName);
    }

    sql += " ORDER BY active_sessions ASC";
    const rows = (await this.db.prepare(sql).all(...params)) as WorkerRow[];
    return rows.map((r) => this.hydrateRow(r));
  }

  /** Get the least loaded online worker, or null if none available. */
  async getLeastLoaded(): Promise<WorkerNode | null> {
    await this.ensureSchema();
    const row = (await this.db
      .prepare(
        `SELECT * FROM workers WHERE status = 'online' AND active_sessions < capacity
       ORDER BY (CAST(active_sessions AS REAL) / capacity) ASC LIMIT 1`,
      )
      .get()) as WorkerRow | undefined;
    return row ? this.hydrateRow(row) : null;
  }

  /** Increment the active session count for a worker. */
  async incrementSessions(workerId: string): Promise<void> {
    await this.ensureSchema();
    await this.db.prepare("UPDATE workers SET active_sessions = active_sessions + 1 WHERE id = ?").run(workerId);
  }

  /** Decrement the active session count for a worker. */
  async decrementSessions(workerId: string): Promise<void> {
    await this.ensureSchema();
    await this.db
      .prepare("UPDATE workers SET active_sessions = MAX(0, active_sessions - 1) WHERE id = ?")
      .run(workerId);
  }

  /**
   * Mark workers as offline if their last heartbeat is older than timeoutMs.
   * Returns the number of workers pruned.
   */
  async pruneStale(timeoutMs: number): Promise<number> {
    await this.ensureSchema();
    const cutoff = new Date(Date.now() - timeoutMs).toISOString();
    const result = await this.db
      .prepare("UPDATE workers SET status = 'offline' WHERE status = 'online' AND last_heartbeat < ?")
      .run(cutoff);
    return result.changes;
  }

  /** Get a single worker by ID. */
  async get(workerId: string): Promise<WorkerNode | null> {
    await this.ensureSchema();
    const row = (await this.db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId)) as WorkerRow | undefined;
    return row ? this.hydrateRow(row) : null;
  }

  private hydrateRow(row: WorkerRow): WorkerNode {
    return {
      id: row.id,
      url: row.url,
      status: row.status,
      capacity: row.capacity,
      active_sessions: row.active_sessions,
      last_heartbeat: row.last_heartbeat,
      compute_name: row.compute_name,
      tenant_id: row.tenant_id,
      metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata ?? {}),
    };
  }
}
