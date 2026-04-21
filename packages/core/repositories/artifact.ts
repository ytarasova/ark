import type { IDatabase } from "../database/index.js";
import type { SessionArtifact, ArtifactType, ArtifactQuery } from "../../types/index.js";
import { now } from "../util/time.js";
import { logDebug } from "../observability/structured-log.js";

interface ArtifactRow {
  id: number;
  session_id: string;
  type: string;
  value: string;
  metadata: string;
  tenant_id: string;
  created_at: string;
}

function rowToArtifact(row: ArtifactRow): SessionArtifact {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || "{}");
  } catch {
    logDebug("general", "malformed JSON in metadata column -- use empty default");
  }
  return {
    ...row,
    type: row.type as ArtifactType,
    metadata,
  };
}

export class ArtifactRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void {
    this.tenantId = tenantId;
  }
  getTenant(): string {
    return this.tenantId;
  }

  /**
   * Record one or more artifacts for a session.
   * Deduplicates by (session_id, type, value) -- existing rows are skipped.
   */
  async add(
    sessionId: string,
    type: ArtifactType,
    values: string[],
    metadata?: Record<string, unknown>,
  ): Promise<SessionArtifact[]> {
    const results: SessionArtifact[] = [];
    const meta = JSON.stringify(metadata ?? {});
    const ts = now();
    for (const value of values) {
      // Skip duplicates
      const existing = await this.db
        .prepare("SELECT id FROM session_artifacts WHERE session_id = ? AND type = ? AND value = ? AND tenant_id = ?")
        .get(sessionId, type, value, this.tenantId);
      if (existing) continue;

      await this.db
        .prepare(
          "INSERT INTO session_artifacts (session_id, type, value, metadata, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(sessionId, type, value, meta, this.tenantId, ts);
      const row = (await this.db
        .prepare(
          "SELECT * FROM session_artifacts WHERE session_id = ? AND type = ? AND value = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1",
        )
        .get(sessionId, type, value, this.tenantId)) as ArtifactRow;
      results.push(rowToArtifact(row));
    }
    return results;
  }

  /** List all artifacts for a session, optionally filtered by type. */
  async list(sessionId: string, type?: ArtifactType): Promise<SessionArtifact[]> {
    let sql = "SELECT * FROM session_artifacts WHERE session_id = ? AND tenant_id = ?";
    const params: any[] = [sessionId, this.tenantId];
    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }
    sql += " ORDER BY id ASC";
    return ((await this.db.prepare(sql).all(...params)) as ArtifactRow[]).map(rowToArtifact);
  }

  /**
   * Query artifacts across sessions. Supports filtering by type, value pattern,
   * or specific session. Useful for "which sessions touched file X?" queries.
   */
  async query(q: ArtifactQuery): Promise<SessionArtifact[]> {
    let sql = "SELECT * FROM session_artifacts WHERE tenant_id = ?";
    const params: any[] = [this.tenantId];

    if (q.session_id) {
      sql += " AND session_id = ?";
      params.push(q.session_id);
    }
    if (q.type) {
      sql += " AND type = ?";
      params.push(q.type);
    }
    if (q.value) {
      sql += " AND value LIKE ?";
      params.push(`%${q.value}%`);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(q.limit ?? 100);

    return ((await this.db.prepare(sql).all(...params)) as ArtifactRow[]).map(rowToArtifact);
  }

  /** Delete all artifacts for a session. Called during session cleanup. */
  async deleteForSession(sessionId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM session_artifacts WHERE session_id = ? AND tenant_id = ?")
      .run(sessionId, this.tenantId);
  }

  /** Count artifacts for a session, optionally by type. */
  async count(sessionId: string, type?: ArtifactType): Promise<number> {
    let sql = "SELECT COUNT(*) as count FROM session_artifacts WHERE session_id = ? AND tenant_id = ?";
    const params: any[] = [sessionId, this.tenantId];
    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }
    const row = (await this.db.prepare(sql).get(...params)) as { count: number };
    return row.count;
  }

  /** Get distinct session IDs that produced a given artifact value. */
  async sessionsForArtifact(type: ArtifactType, value: string): Promise<string[]> {
    const rows = (await this.db
      .prepare(
        "SELECT DISTINCT session_id FROM session_artifacts WHERE type = ? AND value = ? AND tenant_id = ? ORDER BY created_at DESC",
      )
      .all(type, value, this.tenantId)) as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }
}
