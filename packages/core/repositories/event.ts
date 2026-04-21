import type { IDatabase } from "../database/index.js";
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

// -- Helpers --------------------------------------------------------------

function rowToEvent(row: EventRow): Event {
  return { ...row, data: row.data ? JSON.parse(row.data) : null };
}

// -- Repository -----------------------------------------------------------

export class EventRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

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
    await this.db
      .prepare(
        `
      INSERT INTO events (track_id, type, stage, actor, data, tenant_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        trackId,
        type,
        opts?.stage ?? null,
        opts?.actor ?? null,
        opts?.data ? JSON.stringify(opts.data) : null,
        this.tenantId,
        now(),
      );
  }

  async list(trackId: string, opts?: { type?: string; limit?: number }): Promise<Event[]> {
    let sql = "SELECT * FROM events WHERE track_id = ? AND tenant_id = ?";
    const params: any[] = [trackId, this.tenantId];
    if (opts?.type) {
      sql += " AND type = ?";
      params.push(opts.type);
    }
    sql += " ORDER BY id ASC LIMIT ?";
    params.push(opts?.limit ?? 200);

    return ((await this.db.prepare(sql).all(...params)) as EventRow[]).map(rowToEvent);
  }

  async deleteForTrack(trackId: string): Promise<void> {
    await this.db.prepare("DELETE FROM events WHERE track_id = ? AND tenant_id = ?").run(trackId, this.tenantId);
  }
}
