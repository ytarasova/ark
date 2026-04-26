import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, eq } from "drizzle-orm";
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
    // No default cap. The query is already scoped to one trackId + tenant,
    // and a single session's event log is naturally bounded by the work the
    // session actually did. Adding an arbitrary 200-row cap silently
    // truncated the session detail view, dashboard rollups, share exports,
    // task-builder context, and handoff retry counts -- and made Pre/Post
    // tool-call pairs split across the boundary look like stuck "running"
    // tools. Callers that want a small slice already pass `{ limit }`
    // explicitly (dashboard preview = 5, dispatch resume = 1, replay = 1000).
    const d = this.d();
    const e = d.schema.events;
    const filters = [eq(e.trackId, trackId), eq(e.tenantId, this.tenantId)];
    if (opts?.type) filters.push(eq(e.type, opts.type));
    const q = (d.db as any)
      .select()
      .from(e)
      .where(and(...filters))
      .orderBy(asc(e.id));
    const rows = opts?.limit !== undefined ? await q.limit(opts.limit) : await q;
    return (rows as DrizzleSelectEvent[]).map((r) => rowToEvent(drizzleToRow(r)));
  }

  async deleteForTrack(trackId: string): Promise<void> {
    const d = this.d();
    const e = d.schema.events;
    await (d.db as any).delete(e).where(and(eq(e.trackId, trackId), eq(e.tenantId, this.tenantId)));
  }
}
