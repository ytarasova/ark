import type { IDatabase } from "../database/index.js";
import type { Artifact, ArtifactType } from "../../types/index.js";

// ── Row type (metadata stored as JSON string) ─────────────────────────────

interface ArtifactRow {
  id: number;
  session_id: string;
  type: string;
  value: string;
  metadata: string | null;
  stage: string | null;
  tenant_id: string;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function rowToArtifact(row: ArtifactRow): Artifact {
  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); }
    catch { /* malformed JSON -- use empty */ }
  }
  return {
    ...row,
    type: row.type as ArtifactType,
    metadata,
  };
}

// ── Repository ─────────────────────────────────────────────────────────────

export class ArtifactRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void { this.tenantId = tenantId; }
  getTenant(): string { return this.tenantId; }

  /** Add a single artifact for a session. */
  add(
    sessionId: string,
    type: ArtifactType,
    value: string,
    opts?: { stage?: string; metadata?: Record<string, unknown> },
  ): Artifact {
    const ts = now();
    this.db.prepare(`
      INSERT INTO artifacts (session_id, type, value, metadata, stage, tenant_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId, type, value,
      opts?.metadata ? JSON.stringify(opts.metadata) : null,
      opts?.stage ?? null,
      this.tenantId, ts,
    );
    const row = this.db.prepare(
      "SELECT * FROM artifacts WHERE session_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1"
    ).get(sessionId, this.tenantId) as ArtifactRow;
    return rowToArtifact(row);
  }

  /** Batch-add multiple artifacts for a session (e.g. files from a completion report). */
  addMany(
    sessionId: string,
    items: Array<{ type: ArtifactType; value: string; metadata?: Record<string, unknown> }>,
    opts?: { stage?: string },
  ): void {
    const ts = now();
    const stmt = this.db.prepare(`
      INSERT INTO artifacts (session_id, type, value, metadata, stage, tenant_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      stmt.run(
        sessionId, item.type, item.value,
        item.metadata ? JSON.stringify(item.metadata) : null,
        opts?.stage ?? null,
        this.tenantId, ts,
      );
    }
  }

  /** List artifacts for a session, optionally filtered by type. */
  list(sessionId: string, opts?: { type?: ArtifactType; limit?: number }): Artifact[] {
    let sql = "SELECT * FROM artifacts WHERE session_id = ? AND tenant_id = ?";
    const params: any[] = [sessionId, this.tenantId];
    if (opts?.type) { sql += " AND type = ?"; params.push(opts.type); }
    sql += " ORDER BY id ASC LIMIT ?";
    params.push(opts?.limit ?? 500);
    return (this.db.prepare(sql).all(...params) as ArtifactRow[]).map(rowToArtifact);
  }

  /** Get a summary of artifacts for a session: counts by type + unique values. */
  summary(sessionId: string): { commits: number; files: number; prs: number; branches: number } {
    const rows = this.db.prepare(`
      SELECT type, COUNT(*) as count FROM artifacts
      WHERE session_id = ? AND tenant_id = ?
      GROUP BY type
    `).all(sessionId, this.tenantId) as Array<{ type: string; count: number }>;

    const counts = { commits: 0, files: 0, prs: 0, branches: 0 };
    for (const row of rows) {
      switch (row.type) {
        case "commit": counts.commits = row.count; break;
        case "file": counts.files = row.count; break;
        case "pr": counts.prs = row.count; break;
        case "branch": counts.branches = row.count; break;
      }
    }
    return counts;
  }

  /** Delete all artifacts for a session (used during session deletion). */
  deleteForSession(sessionId: string): void {
    this.db.prepare("DELETE FROM artifacts WHERE session_id = ? AND tenant_id = ?").run(sessionId, this.tenantId);
  }
}
