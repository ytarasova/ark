import { Database } from "bun:sqlite";
import type { Event } from "../../types/index.js";

// ── Row type (data stored as JSON string) ───────────────────────────────────

interface EventRow {
  id: number;
  track_id: string;
  type: string;
  stage: string | null;
  actor: string | null;
  data: string | null;
  created_at: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function rowToEvent(row: EventRow): Event {
  return { ...row, data: row.data ? JSON.parse(row.data) : null };
}

// ── Repository ──────────────────────────────────────────────────────────────

export class EventRepository {
  constructor(private db: Database) {}

  log(
    trackId: string,
    type: string,
    opts?: { stage?: string; actor?: string; data?: Record<string, unknown> },
  ): void {
    this.db.prepare(`
      INSERT INTO events (track_id, type, stage, actor, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      trackId, type, opts?.stage ?? null, opts?.actor ?? null,
      opts?.data ? JSON.stringify(opts.data) : null, now(),
    );
  }

  list(
    trackId: string,
    opts?: { type?: string; limit?: number },
  ): Event[] {
    let sql = "SELECT * FROM events WHERE track_id = ?";
    const params: any[] = [trackId];
    if (opts?.type) { sql += " AND type = ?"; params.push(opts.type); }
    sql += " ORDER BY id ASC LIMIT ?";
    params.push(opts?.limit ?? 200);

    return (this.db.prepare(sql).all(...params) as EventRow[]).map(rowToEvent);
  }

  deleteForTrack(trackId: string): void {
    this.db.prepare("DELETE FROM events WHERE track_id = ?").run(trackId);
  }
}
