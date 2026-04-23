import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Event } from "../../types/index.js";
import { now } from "../util/time.js";

// -- Row type (data stored as JSON string) --------------------------------

interface EventRow {
  id: number;
  track_id: string;
  type: string;
  stage: string | null;
  actor: string | null;
  data: string | null;
  created_at: string;
}

type DrizzleSelectEvent = {
  id: number;
  trackId: string;
  type: string;
  stage: string | null;
  actor: string | null;
  data: string | null;
  tenantId: string;
  createdAt: string;
};

function drizzleToRow(row: DrizzleSelectEvent): EventRow {
  return {
    id: row.id,
    track_id: row.trackId,
    type: row.type,
    stage: row.stage,
    actor: row.actor,
    data: row.data,
    created_at: row.createdAt,
  };
}

function rowToEvent(row: EventRow): Event {
  return { ...row, data: row.data ? JSON.parse(row.data) : null };
}

export class EventRepository {
  private tenantId: string = "default";
  private _d: DrizzleClient | null = null;

  constructor(private db: DatabaseAdapter) {}

  private d(): DrizzleClient {
    if (!this._d) this._d = drizzleFromIDatabase(this.db);
    return this._d;
  }

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  async log(
    trackId: string,
    type: string,
    opts?: { stage?: string; actor?: string; data?: Record<string, unknown> },
  ): Promise<void> {
    const d = this.d();
    await (d.db as any).insert(d.schema.events).values({
      trackId,
      type,
      stage: opts?.stage ?? null,
      actor: opts?.actor ?? null,
      data: opts?.data ? JSON.stringify(opts.data) : null,
      tenantId: this.tenantId,
      createdAt: now(),
    });
  }

  async list(trackId: string, opts?: { type?: string; limit?: number }): Promise<Event[]> {
    const d = this.d();
    const e = d.schema.events;
    const filters = [eq(e.trackId, trackId), eq(e.tenantId, this.tenantId)];
    if (opts?.type) filters.push(eq(e.type, opts.type));
    const rows = await (d.db as any)
      .select()
      .from(e)
      .where(and(...filters))
      .orderBy(asc(e.id))
      .limit(opts?.limit ?? 200);
    return (rows as DrizzleSelectEvent[]).map((r) => rowToEvent(drizzleToRow(r)));
  }

  /**
   * Sum `data.total_cost_usd` across hook_status events whose payload
   * `hook_event_name` matches one of `hookNames`, for one or more track ids.
   *
   * Pushes the aggregate to SQL so the caller avoids a full table scan +
   * JS-side JSON.parse per event (the `for_each` budget loop called
   * `events.list(...)` once per iteration, which was O(N^2) for large loops).
   *
   * Dual-dialect:
   *   - SQLite: `json_extract(data, '$.hook_event_name')` /
   *     `CAST(json_extract(data, '$.total_cost_usd') AS REAL)`.
   *   - Postgres: `data` is stored as TEXT, so cast to `::json` first.
   *
   * Events whose `total_cost_usd` is missing / non-numeric contribute 0
   * (SUM ignores NULLs; non-numeric JSON values return NULL from the cast).
   */
  async sumHookCost(trackIds: string | string[], hookNames: string[]): Promise<number> {
    const ids = Array.isArray(trackIds) ? trackIds : [trackIds];
    if (ids.length === 0 || hookNames.length === 0) return 0;

    const d = this.d();
    const e = d.schema.events;

    const trackFilter = ids.length === 1 ? eq(e.trackId, ids[0]) : inArray(e.trackId, ids);

    const [hookExpr, costExpr] =
      d.dialect === "sqlite"
        ? [
            sql`json_extract(${e.data}, '$.hook_event_name')`,
            sql`CAST(json_extract(${e.data}, '$.total_cost_usd') AS REAL)`,
          ]
        : [
            sql`((${e.data})::json ->> 'hook_event_name')`,
            sql`NULLIF((${e.data})::json ->> 'total_cost_usd', '')::double precision`,
          ];

    const rows = await (d.db as any)
      .select({ total: sql<number>`COALESCE(SUM(${costExpr}), 0)` })
      .from(e)
      .where(and(trackFilter, eq(e.tenantId, this.tenantId), eq(e.type, "hook_status"), inArray(hookExpr, hookNames)));

    const raw = (rows as Array<{ total: number | string | null }>)[0]?.total ?? 0;
    const num = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(num) ? num : 0;
  }

  async deleteForTrack(trackId: string): Promise<void> {
    const d = this.d();
    const e = d.schema.events;
    await (d.db as any).delete(e).where(and(eq(e.trackId, trackId), eq(e.tenantId, this.tenantId)));
  }
}
