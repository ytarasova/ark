import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, asc, desc, eq, like, sql } from "drizzle-orm";
import type { SessionArtifact, ArtifactType, ArtifactQuery } from "../../types/index.js";
import { now } from "../util/time.js";
import { logDebug } from "../observability/structured-log.js";

type DrizzleSelectArtifact = {
  id: number;
  sessionId: string;
  type: string;
  value: string;
  metadata: string | null;
  tenantId: string;
  createdAt: string;
};

function drizzleToArtifact(row: DrizzleSelectArtifact): SessionArtifact {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata || "{}");
  } catch {
    logDebug("general", "malformed JSON in metadata column -- use empty default");
  }
  return {
    id: row.id,
    session_id: row.sessionId,
    type: row.type as ArtifactType,
    value: row.value,
    metadata,
    tenant_id: row.tenantId,
    created_at: row.createdAt,
  };
}

export class ArtifactRepository {
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
    const d = this.d();
    const a = d.schema.sessionArtifacts;

    for (const value of values) {
      // Skip duplicates
      const existing = await (d.db as any)
        .select({ id: a.id })
        .from(a)
        .where(and(eq(a.sessionId, sessionId), eq(a.type, type), eq(a.value, value), eq(a.tenantId, this.tenantId)))
        .limit(1);
      if ((existing as any[]).length > 0) continue;

      await (d.db as any).insert(a).values({
        sessionId,
        type,
        value,
        metadata: meta,
        tenantId: this.tenantId,
        createdAt: ts,
      });
      const latest = await (d.db as any)
        .select()
        .from(a)
        .where(and(eq(a.sessionId, sessionId), eq(a.type, type), eq(a.value, value), eq(a.tenantId, this.tenantId)))
        .orderBy(desc(a.id))
        .limit(1);
      const row = (latest as DrizzleSelectArtifact[])[0];
      if (row) results.push(drizzleToArtifact(row));
    }
    return results;
  }

  /** List all artifacts for a session, optionally filtered by type. */
  async list(sessionId: string, type?: ArtifactType): Promise<SessionArtifact[]> {
    const d = this.d();
    const a = d.schema.sessionArtifacts;
    const filters = [eq(a.sessionId, sessionId), eq(a.tenantId, this.tenantId)];
    if (type) filters.push(eq(a.type, type));
    const rows = await (d.db as any)
      .select()
      .from(a)
      .where(and(...filters))
      .orderBy(asc(a.id));
    return (rows as DrizzleSelectArtifact[]).map(drizzleToArtifact);
  }

  /** Query artifacts across sessions. */
  async query(q: ArtifactQuery): Promise<SessionArtifact[]> {
    const d = this.d();
    const a = d.schema.sessionArtifacts;
    const filters: any[] = [eq(a.tenantId, this.tenantId)];
    if (q.session_id) filters.push(eq(a.sessionId, q.session_id));
    if (q.type) filters.push(eq(a.type, q.type));
    if (q.value) filters.push(like(a.value, `%${q.value}%`));

    const rows = await (d.db as any)
      .select()
      .from(a)
      .where(and(...filters))
      .orderBy(desc(a.createdAt))
      .limit(q.limit ?? 100);
    return (rows as DrizzleSelectArtifact[]).map(drizzleToArtifact);
  }

  /** Delete all artifacts for a session. */
  async deleteForSession(sessionId: string): Promise<void> {
    const d = this.d();
    const a = d.schema.sessionArtifacts;
    await (d.db as any).delete(a).where(and(eq(a.sessionId, sessionId), eq(a.tenantId, this.tenantId)));
  }

  /** Count artifacts for a session, optionally by type. */
  async count(sessionId: string, type?: ArtifactType): Promise<number> {
    const d = this.d();
    const a = d.schema.sessionArtifacts;
    const filters = [eq(a.sessionId, sessionId), eq(a.tenantId, this.tenantId)];
    if (type) filters.push(eq(a.type, type));
    const rows = await (d.db as any)
      .select({ count: sql<number>`COUNT(*)` })
      .from(a)
      .where(and(...filters));
    const row = (rows as Array<{ count: number | string }>)[0];
    return Number(row?.count ?? 0);
  }

  /** Get distinct session IDs that produced a given artifact value. */
  async sessionsForArtifact(type: ArtifactType, value: string): Promise<string[]> {
    const d = this.d();
    const a = d.schema.sessionArtifacts;
    const rows = await (d.db as any)
      .selectDistinct({ sessionId: a.sessionId, createdAt: a.createdAt })
      .from(a)
      .where(and(eq(a.type, type), eq(a.value, value), eq(a.tenantId, this.tenantId)))
      .orderBy(desc(a.createdAt));
    // Dedup in JS (SELECT DISTINCT on (session_id, createdAt) may return
    // per-row). Preserve ordering by first-seen.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of rows as Array<{ sessionId: string }>) {
      if (!seen.has(row.sessionId)) {
        seen.add(row.sessionId);
        out.push(row.sessionId);
      }
    }
    return out;
  }
}
