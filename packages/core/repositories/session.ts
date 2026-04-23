import type { DatabaseAdapter } from "../database/index.js";
import { drizzleFromIDatabase } from "../drizzle/from-idb.js";
import type { DrizzleClient } from "../drizzle/client.js";
import { and, desc, eq, like, ne, or, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import type {
  Session,
  SessionStatus,
  SessionConfig,
  CreateSessionOpts,
  SessionListFilters,
} from "../../types/index.js";
import { now } from "../util/time.js";

// URL-safe lowercase alphanumeric alphabet. 10 chars ~= 51.7 bits of entropy.
const SESSION_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const sessionIdSuffix = customAlphabet(SESSION_ID_ALPHABET, 10);

// -- Drizzle row (camelCase) → public session (snake_case) ---------------

type DrizzleSelectSession = {
  id: string;
  ticket: string | null;
  summary: string | null;
  repo: string | null;
  branch: string | null;
  computeName: string | null;
  sessionId: string | null;
  claudeSessionId: string | null;
  stage: string | null;
  status: string;
  flow: string;
  agent: string | null;
  workdir: string | null;
  prUrl: string | null;
  prId: string | null;
  error: string | null;
  parentId: string | null;
  forkGroup: string | null;
  groupName: string | null;
  breakpointReason: string | null;
  attachedBy: string | null;
  rejectionCount: number | null;
  reworkPrompt: string | null;
  rejectedAt: string | null;
  rejectedReason: string | null;
  ptyCols: number | null;
  ptyRows: number | null;
  config: string | null;
  userId: string | null;
  tenantId: string;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
};

// -- Helpers --------------------------------------------------------------

function safeParseConfig(raw: unknown): SessionConfig {
  if (typeof raw === "object" && raw !== null) return raw as SessionConfig;
  try {
    return JSON.parse(String(raw ?? "{}"));
  } catch {
    return {};
  }
}

function rowToSession(row: DrizzleSelectSession): Session {
  return {
    id: row.id,
    ticket: row.ticket,
    summary: row.summary,
    repo: row.repo,
    branch: row.branch,
    compute_name: row.computeName,
    session_id: row.sessionId,
    claude_session_id: row.claudeSessionId,
    stage: row.stage,
    status: row.status as SessionStatus,
    flow: row.flow,
    agent: row.agent,
    workdir: row.workdir,
    pr_url: row.prUrl,
    pr_id: row.prId,
    error: row.error,
    parent_id: row.parentId,
    fork_group: row.forkGroup,
    group_name: row.groupName,
    breakpoint_reason: row.breakpointReason,
    attached_by: row.attachedBy,
    rejection_count: typeof row.rejectionCount === "number" ? row.rejectionCount : 0,
    rework_prompt: row.reworkPrompt ?? null,
    rejected_at: row.rejectedAt ?? null,
    rejected_reason: row.rejectedReason ?? null,
    pty_cols: typeof row.ptyCols === "number" ? row.ptyCols : null,
    pty_rows: typeof row.ptyRows === "number" ? row.ptyRows : null,
    config: safeParseConfig(row.config),
    user_id: row.userId,
    tenant_id: row.tenantId,
    workspace_id: row.workspaceId,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  } as Session;
}

/**
 * Map a snake_case session field name to the drizzle/camelCase column
 * accessor. Returns `null` for fields that either don't exist on the
 * schema or are read-only (id, created_at).
 */
function snakeToDrizzleColumn(key: string, schema: DrizzleClient["schema"]): { col: any; jsonEncode: boolean } | null {
  const s = (schema as any).sessions;
  switch (key) {
    case "ticket":
      return { col: s.ticket, jsonEncode: false };
    case "summary":
      return { col: s.summary, jsonEncode: false };
    case "repo":
      return { col: s.repo, jsonEncode: false };
    case "branch":
      return { col: s.branch, jsonEncode: false };
    case "compute_name":
      return { col: s.computeName, jsonEncode: false };
    case "session_id":
      return { col: s.sessionId, jsonEncode: false };
    case "claude_session_id":
      return { col: s.claudeSessionId, jsonEncode: false };
    case "stage":
      return { col: s.stage, jsonEncode: false };
    case "status":
      return { col: s.status, jsonEncode: false };
    case "flow":
      return { col: s.flow, jsonEncode: false };
    case "agent":
      return { col: s.agent, jsonEncode: false };
    case "workdir":
      return { col: s.workdir, jsonEncode: false };
    case "pr_url":
      return { col: s.prUrl, jsonEncode: false };
    case "pr_id":
      return { col: s.prId, jsonEncode: false };
    case "error":
      return { col: s.error, jsonEncode: false };
    case "parent_id":
      return { col: s.parentId, jsonEncode: false };
    case "fork_group":
      return { col: s.forkGroup, jsonEncode: false };
    case "group_name":
      return { col: s.groupName, jsonEncode: false };
    case "breakpoint_reason":
      return { col: s.breakpointReason, jsonEncode: false };
    case "attached_by":
      return { col: s.attachedBy, jsonEncode: false };
    case "rejection_count":
      return { col: s.rejectionCount, jsonEncode: false };
    case "rework_prompt":
      return { col: s.reworkPrompt, jsonEncode: false };
    case "rejected_at":
      return { col: s.rejectedAt, jsonEncode: false };
    case "rejected_reason":
      return { col: s.rejectedReason, jsonEncode: false };
    case "pty_cols":
      return { col: s.ptyCols, jsonEncode: false };
    case "pty_rows":
      return { col: s.ptyRows, jsonEncode: false };
    case "config":
      return { col: s.config, jsonEncode: true };
    case "user_id":
      return { col: s.userId, jsonEncode: false };
    case "workspace_id":
      return { col: s.workspaceId, jsonEncode: false };
    case "updated_at":
      return { col: s.updatedAt, jsonEncode: false };
    default:
      return null;
  }
}

/**
 * Project a `Partial<Session>` into a drizzle-friendly `set` object.
 * Skips id / created_at (read-only) and JSON-stringifies `config`.
 */
function buildDrizzleSet(fields: Partial<Session>, schema: DrizzleClient["schema"]): Record<string, any> {
  const set: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "id" || key === "created_at") continue;
    const map = snakeToDrizzleColumn(key, schema);
    if (!map) continue;
    const colName = (map.col as any).name as string;
    if (map.jsonEncode && typeof value === "object" && value !== null) {
      set[toDrizzleKey(colName)] = JSON.stringify(value);
    } else {
      set[toDrizzleKey(colName)] = value ?? null;
    }
  }
  return set;
}

function toDrizzleKey(sqlColumn: string): string {
  // Convert SQL snake_case column name back to the drizzle TS property
  // name. Our schema uses explicit TS names that are camelCase, so this
  // reverse-mapping matches the schema's key derivation:
  //   compute_name -> computeName
  return sqlColumn.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

// -- Repository -----------------------------------------------------------

export class SessionRepository {
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

  async create(opts: CreateSessionOpts): Promise<Session> {
    const id = await this.generateId();
    const ts = now();
    const sanitize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^-|-$/g, "");
    // Caller-provided branch wins (deterministic dispatch from for_each + spawn,
    // sage RPC, or `--branch` CLI flag). Fall back to ticket-derived name, else
    // null (setupWorktree will then default to `ark-<sessionId>`).
    const branch =
      opts.branch ??
      (opts.ticket ? `feat/${sanitize(opts.ticket)}-${sanitize(opts.summary ?? "work").slice(0, 30)}` : null);

    const d = this.d();
    await (d.db as any).insert(d.schema.sessions).values({
      id,
      ticket: opts.ticket ?? null,
      summary: opts.summary ?? null,
      repo: opts.repo ?? null,
      branch,
      computeName: opts.compute_name ?? null,
      workdir: opts.workdir ?? null,
      stage: null,
      status: "pending",
      flow: opts.flow ?? "default",
      agent: opts.agent ?? null,
      groupName: opts.group_name ?? null,
      config: JSON.stringify({
        ...(opts.config ?? {}),
        // Promote top-level max_budget_usd into config so dispatchers can read it.
        ...(opts.max_budget_usd !== undefined ? { max_budget_usd: opts.max_budget_usd } : {}),
      }),
      userId: opts.user_id ?? null,
      tenantId: this.tenantId,
      workspaceId: opts.workspace_id ?? null,
      createdAt: ts,
      updatedAt: ts,
    });

    return (await this.get(id))!;
  }

  async get(id: string): Promise<Session | null> {
    const d = this.d();
    const s = d.schema.sessions;
    const rows = await (d.db as any)
      .select()
      .from(s)
      .where(and(eq(s.id, id), eq(s.tenantId, this.tenantId)))
      .limit(1);
    const row = (rows as DrizzleSelectSession[])[0];
    return row ? rowToSession(row) : null;
  }

  async list(filters?: SessionListFilters): Promise<Session[]> {
    const d = this.d();
    const s = d.schema.sessions;
    const conditions: any[] = [eq(s.tenantId, this.tenantId), ne(s.status, "deleting")];

    if (!filters?.status || filters.status !== "archived") {
      conditions.push(ne(s.status, "archived"));
    }

    if (filters?.status) conditions.push(eq(s.status, filters.status));
    if (filters?.repo) conditions.push(eq(s.repo, filters.repo));
    if (filters?.group_name) conditions.push(eq(s.groupName, filters.group_name));
    if (filters?.groupPrefix) conditions.push(like(s.groupName, filters.groupPrefix + "%"));
    if (filters?.parent_id) conditions.push(eq(s.parentId, filters.parent_id));
    if (filters?.flow) conditions.push(eq(s.flow, filters.flow));

    const rows = await (d.db as any)
      .select()
      .from(s)
      .where(and(...conditions))
      .orderBy(desc(s.createdAt))
      .limit(filters?.limit ?? 100);
    return (rows as DrizzleSelectSession[]).map(rowToSession);
  }

  async update(id: string, fields: Partial<Session>): Promise<Session | null> {
    const d = this.d();
    const s = d.schema.sessions;
    const set = buildDrizzleSet(fields, d.schema);
    set.updatedAt = now();
    await (d.db as any)
      .update(s)
      .set(set)
      .where(and(eq(s.id, id), eq(s.tenantId, this.tenantId)));
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const d = this.d();
    // Cascade to events + artifacts first (same tenant).
    await (d.db as any)
      .delete(d.schema.events)
      .where(and(eq(d.schema.events.trackId, id), eq(d.schema.events.tenantId, this.tenantId)));
    await (d.db as any)
      .delete(d.schema.sessionArtifacts)
      .where(and(eq(d.schema.sessionArtifacts.sessionId, id), eq(d.schema.sessionArtifacts.tenantId, this.tenantId)));
    const res = await (d.db as any)
      .delete(d.schema.sessions)
      .where(and(eq(d.schema.sessions.id, id), eq(d.schema.sessions.tenantId, this.tenantId)));
    return extractChangesLocal(res) > 0;
  }

  async softDelete(id: string): Promise<boolean> {
    const session = await this.get(id);
    if (!session) return false;
    const config = {
      ...session.config,
      _pre_delete_status: session.status,
      _deleted_at: new Date().toISOString(),
    };
    await this.update(id, { status: "deleting" as SessionStatus, config } as Partial<Session>);
    return true;
  }

  async undelete(id: string): Promise<Session | null> {
    const session = await this.get(id);
    if (!session || session.status !== "deleting") return null;
    const prevStatus = (session.config._pre_delete_status as SessionStatus) || "pending";
    const { _pre_delete_status, _deleted_at, ...cleanConfig } = session.config;
    void _pre_delete_status;
    void _deleted_at;
    await this.update(id, { status: prevStatus, config: cleanConfig as SessionConfig } as Partial<Session>);
    return this.get(id);
  }

  async claim(id: string, expected: SessionStatus, next: SessionStatus, extra?: Partial<Session>): Promise<boolean> {
    const d = this.d();
    const s = d.schema.sessions;

    // `status` + `updated_at` are fixed by claim semantics.
    const safeExtra: Partial<Session> = extra ? { ...extra } : {};
    delete (safeExtra as { status?: SessionStatus }).status;

    const set = buildDrizzleSet(safeExtra, d.schema);
    set.status = next;
    set.updatedAt = now();

    const res = await (d.db as any)
      .update(s)
      .set(set)
      .where(and(eq(s.id, id), eq(s.status, expected), eq(s.tenantId, this.tenantId)));
    return extractChangesLocal(res) > 0;
  }

  async purgeDeleted(olderThanMs?: number): Promise<number> {
    const cutoff = olderThanMs ?? 90_000;
    const d = this.d();
    const s = d.schema.sessions;
    const rows = await (d.db as any)
      .select()
      .from(s)
      .where(and(eq(s.tenantId, this.tenantId), eq(s.status, "deleting")))
      .orderBy(desc(s.updatedAt));
    const deleted = (rows as DrizzleSelectSession[]).map(rowToSession);

    let count = 0;
    const cutoffTime = Date.now() - cutoff;
    for (const ses of deleted) {
      const deletedAt = ses.config._deleted_at as string | undefined;
      if (deletedAt && new Date(deletedAt).getTime() < cutoffTime) {
        await this.delete(ses.id);
        count++;
      }
    }
    return count;
  }

  /**
   * Hash a sessionId into a port in [basePort, basePort + range). Parses
   * the suffix as base-36 (superset of hex) with a stable djb2 fallback.
   */
  channelPort(sessionId: string): number {
    const { basePort, range } = this.getChannelBounds();
    const suffix = sessionId.startsWith("s-") ? sessionId.slice(2) : sessionId;
    const n = parseInt(suffix, 36);
    const h = Number.isFinite(n) ? n : stableStringHash(suffix);
    return basePort + (Math.abs(h) % range);
  }

  private _channelBounds: { basePort: number; range: number } | null = null;

  setChannelBounds(basePort: number, range: number): void {
    this._channelBounds = { basePort, range };
  }

  private getChannelBounds(): { basePort: number; range: number } {
    if (this._channelBounds) return this._channelBounds;
    const base = parseInt(process.env.ARK_CHANNEL_BASE_PORT ?? "19200", 10);
    const range = parseInt(process.env.ARK_CHANNEL_RANGE ?? "10000", 10);
    return {
      basePort: Number.isFinite(base) ? base : 19200,
      range: Number.isFinite(range) ? range : 10000,
    };
  }

  async mergeConfig(sessionId: string, patch: Partial<SessionConfig>): Promise<void> {
    await this.db.transaction(async () => {
      const d = this.d();
      const s = d.schema.sessions;
      const rows = await (d.db as any)
        .select({ config: s.config })
        .from(s)
        .where(and(eq(s.id, sessionId), eq(s.tenantId, this.tenantId)))
        .limit(1);
      const row = (rows as Array<{ config: string | null }>)[0];
      if (!row) return;
      const existing = safeParseConfig(row.config);
      const merged = { ...existing, ...patch };
      await (d.db as any)
        .update(s)
        .set({ config: JSON.stringify(merged), updatedAt: new Date().toISOString() })
        .where(and(eq(s.id, sessionId), eq(s.tenantId, this.tenantId)));
    });
  }

  async search(query: string, opts?: { limit?: number }): Promise<Session[]> {
    const limit = opts?.limit ?? 50;
    const pattern = `%${query}%`;
    const d = this.d();
    const s = d.schema.sessions;
    const rows = await (d.db as any)
      .select()
      .from(s)
      .where(
        and(
          eq(s.tenantId, this.tenantId),
          ne(s.status, "deleting"),
          or(like(s.ticket, pattern), like(s.summary, pattern), like(s.repo, pattern), like(s.id, pattern)),
        ),
      )
      .orderBy(desc(s.createdAt))
      .limit(limit);
    return (rows as DrizzleSelectSession[]).map(rowToSession);
  }

  async getChildren(parentId: string): Promise<Session[]> {
    return this.list({ parent_id: parentId });
  }

  async getGroups(): Promise<Array<{ name: string; created_at: string }>> {
    const d = this.d();
    const g = d.schema.groups;
    const rows = await (d.db as any)
      .select({ name: g.name, createdAt: g.createdAt })
      .from(g)
      .where(eq(g.tenantId, this.tenantId))
      .orderBy(g.name);
    return (rows as Array<{ name: string; createdAt: string }>).map((r) => ({
      name: r.name,
      created_at: r.createdAt,
    }));
  }

  /** Return all group names -- union of groups + distinct session group_names, sorted. */
  async getGroupNames(): Promise<string[]> {
    // Drizzle's `union` support between two queries isn't a clean fit for
    // the "DISTINCT non-null" half, so we do two small queries and merge
    // in JS. Lower hit-rate compared to a UNION but results are small
    // (group names per tenant count in the dozens).
    const d = this.d();
    const g = d.schema.groups;
    const s = d.schema.sessions;

    const groupRows = (await (d.db as any)
      .select({ name: g.name })
      .from(g)
      .where(eq(g.tenantId, this.tenantId))) as Array<{ name: string }>;

    const sessionRows = (await (d.db as any)
      .selectDistinct({ name: s.groupName })
      .from(s)
      .where(and(eq(s.tenantId, this.tenantId), sql`${s.groupName} IS NOT NULL`))) as Array<{ name: string | null }>;

    const set = new Set<string>();
    for (const r of groupRows) set.add(r.name);
    for (const r of sessionRows) if (r.name) set.add(r.name);
    return Array.from(set).sort();
  }

  async createGroup(name: string): Promise<void> {
    // Drizzle's .onConflictDoNothing() is sqlite-core only; postgres-core
    // uses .onConflictDoNothing() too but via a different import path.
    // Both schemas expose a primary-key pair so the conflict target is
    // implicit. Using the typed API on both dialects:
    const d = this.d();
    const g = d.schema.groups;
    await (d.db as any).insert(g).values({ name, tenantId: this.tenantId, createdAt: now() }).onConflictDoNothing();
  }

  async deleteGroup(name: string): Promise<void> {
    const d = this.d();
    const g = d.schema.groups;
    const s = d.schema.sessions;
    await (d.db as any).delete(g).where(and(eq(g.name, name), eq(g.tenantId, this.tenantId)));
    await (d.db as any)
      .update(s)
      .set({ groupName: null })
      .where(and(eq(s.groupName, name), eq(s.tenantId, this.tenantId)));
  }

  /** List sessions in 'deleting' status (soft-deleted). */
  async listDeleted(): Promise<Session[]> {
    const d = this.d();
    const s = d.schema.sessions;
    const rows = await (d.db as any)
      .select()
      .from(s)
      .where(and(eq(s.tenantId, this.tenantId), eq(s.status, "deleting")))
      .orderBy(desc(s.updatedAt));
    return (rows as DrizzleSelectSession[]).map(rowToSession);
  }

  /** Generate a unique session ID (s-<10 url-safe chars>). */
  async generateId(): Promise<string> {
    const d = this.d();
    const s = d.schema.sessions;
    while (true) {
      const id = `s-${sessionIdSuffix()}`;
      const rows = await (d.db as any).select({ id: s.id }).from(s).where(eq(s.id, id)).limit(1);
      if ((rows as any[]).length === 0) return id;
    }
  }

  /** Check whether a channel port is in use by any running/waiting session. */
  async isChannelPortAvailable(port: number, excludeSessionId?: string): Promise<boolean> {
    const d = this.d();
    const s = d.schema.sessions;
    const rows = (await (d.db as any)
      .select({ id: s.id })
      .from(s)
      .where(
        and(
          eq(s.tenantId, this.tenantId),
          or(eq(s.status, "running"), eq(s.status, "waiting")),
          ne(s.id, excludeSessionId ?? ""),
        ),
      )) as Array<{ id: string }>;
    return !rows.some((r) => this.channelPort(r.id) === port);
  }
}

function extractChangesLocal(res: unknown): number {
  if (!res || typeof res !== "object") return 0;
  const r = res as { changes?: number; rowCount?: number; count?: number };
  if (typeof r.changes === "number") return r.changes;
  if (typeof r.rowCount === "number") return r.rowCount;
  if (typeof r.count === "number") return r.count;
  return 0;
}

/**
 * Djb2-style string hash, stable across processes.
 */
function stableStringHash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}
