import type { IDatabase } from "../database/index.js";
import { randomBytes } from "crypto";
import type {
  Session,
  SessionStatus,
  SessionConfig,
  CreateSessionOpts,
  SessionListFilters,
} from "../../types/index.js";

// ── Row type (config stored as JSON string) ─────────────────────────────────

interface SessionRow {
  id: string;
  ticket: string | null;
  summary: string | null;
  repo: string | null;
  branch: string | null;
  compute_name: string | null;
  session_id: string | null;
  claude_session_id: string | null;
  stage: string | null;
  status: string;
  flow: string;
  agent: string | null;
  workdir: string | null;
  pr_url: string | null;
  pr_id: string | null;
  error: string | null;
  parent_id: string | null;
  fork_group: string | null;
  group_name: string | null;
  breakpoint_reason: string | null;
  attached_by: string | null;
  config: string;
  user_id: string | null;
  tenant_id: string;
  created_at: string;
  updated_at: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function safeParseConfig(raw: unknown): SessionConfig {
  if (typeof raw === "object" && raw !== null) return raw as SessionConfig;
  try { return JSON.parse(String(raw ?? "{}")); }
  catch { return {}; }
}

function rowToSession(row: SessionRow): Session {
  return {
    ...row,
    status: row.status as SessionStatus,
    config: safeParseConfig(row.config),
  };
}

// Valid session columns (from schema). Used to whitelist dynamic SQL column names.
const SESSION_COLUMNS = new Set([
  "ticket", "summary", "repo", "branch", "compute_name", "session_id",
  "claude_session_id", "stage", "status", "flow", "agent", "workdir",
  "pr_url", "pr_id", "error", "parent_id", "fork_group", "group_name",
  "breakpoint_reason", "attached_by", "config", "user_id", "updated_at",
]);

// ── Repository ──────────────────────────────────────────────────────────────

export class SessionRepository {
  private tenantId: string = "default";

  constructor(private db: IDatabase) {}

  setTenant(tenantId: string): void { this.tenantId = tenantId; }
  getTenant(): string { return this.tenantId; }

  create(opts: CreateSessionOpts): Session {
    const id = this.generateId();
    const ts = now();
    const branch = opts.ticket
      ? `feat/${opts.ticket}-${(opts.summary ?? "work").toLowerCase().replace(/\s+/g, "-").slice(0, 30)}`
      : null;

    this.db.prepare(`
      INSERT INTO sessions (id, ticket, summary, repo, branch, compute_name,
        workdir, stage, status, flow, agent, group_name, config, user_id, tenant_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.ticket ?? null, opts.summary ?? null, opts.repo ?? null,
      branch, opts.compute_name ?? null, opts.workdir ?? null,
      opts.flow ?? "default", opts.agent ?? null, opts.group_name ?? null,
      JSON.stringify(opts.config ?? {}), opts.user_id ?? null, this.tenantId, ts, ts,
    );

    return this.get(id)!;
  }

  get(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ? AND tenant_id = ?").get(id, this.tenantId) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  list(filters?: SessionListFilters): Session[] {
    let sql = "SELECT * FROM sessions WHERE tenant_id = ? AND status != 'deleting'";
    const params: any[] = [this.tenantId];

    // Exclude archived sessions unless explicitly filtering for them
    if (!filters?.status || filters.status !== "archived") {
      sql += " AND status != 'archived'";
    }

    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.repo) { sql += " AND repo = ?"; params.push(filters.repo); }
    if (filters?.group_name) { sql += " AND group_name = ?"; params.push(filters.group_name); }
    if (filters?.groupPrefix) { sql += " AND group_name LIKE ?"; params.push(filters.groupPrefix + "%"); }
    if (filters?.parent_id) { sql += " AND parent_id = ?"; params.push(filters.parent_id); }
    if (filters?.flow) { sql += " AND flow = ?"; params.push(filters.flow); }

    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(filters?.limit ?? 100);

    return (this.db.prepare(sql).all(...params) as SessionRow[]).map(rowToSession);
  }

  update(id: string, fields: Partial<Session>): Session | null {
    const updates: string[] = ["updated_at = ?"];
    const values: any[] = [now()];

    for (const [key, value] of Object.entries(fields)) {
      if (key === "id" || key === "created_at") continue;
      if (!SESSION_COLUMNS.has(key)) continue;
      if (key === "config" && typeof value === "object") {
        updates.push("config = ?");
        values.push(JSON.stringify(value));
      } else {
        updates.push(`${key} = ?`);
        values.push(value ?? null);
      }
    }
    values.push(id, this.tenantId);

    this.db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ? AND tenant_id = ?`).run(...values);
    return this.get(id);
  }

  delete(id: string): boolean {
    this.db.prepare("DELETE FROM events WHERE track_id = ? AND tenant_id = ?").run(id, this.tenantId);
    this.db.prepare("DELETE FROM session_artifacts WHERE session_id = ? AND tenant_id = ?").run(id, this.tenantId);
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ? AND tenant_id = ?").run(id, this.tenantId);
    return result.changes > 0;
  }

  softDelete(id: string): boolean {
    const session = this.get(id);
    if (!session) return false;
    const config = {
      ...session.config,
      _pre_delete_status: session.status,
      _deleted_at: new Date().toISOString(),
    };
    this.update(id, { status: "deleting" as SessionStatus, config } as Partial<Session>);
    return true;
  }

  undelete(id: string): Session | null {
    const session = this.get(id);
    if (!session || session.status !== "deleting") return null;
    const prevStatus = (session.config._pre_delete_status as SessionStatus) || "pending";
    const { _pre_delete_status, _deleted_at, ...cleanConfig } = session.config;
    this.update(id, { status: prevStatus, config: cleanConfig as SessionConfig } as Partial<Session>);
    return this.get(id);
  }

  claim(id: string, expected: SessionStatus, next: SessionStatus, extra?: Partial<Session>): boolean {
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const values: any[] = [next, now()];

    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (!SESSION_COLUMNS.has(key)) continue;
        updates.push(`${key} = ?`);
        values.push(key === "config" ? JSON.stringify(value) : value ?? null);
      }
    }
    values.push(id, expected, this.tenantId);

    const result = this.db.prepare(
      `UPDATE sessions SET ${updates.join(", ")} WHERE id = ? AND status = ? AND tenant_id = ?`
    ).run(...values);
    return result.changes > 0;
  }

  purgeDeleted(olderThanMs?: number): number {
    const cutoff = olderThanMs ?? 90_000;
    const deleted = (this.db.prepare(
      "SELECT * FROM sessions WHERE tenant_id = ? AND status = 'deleting' ORDER BY updated_at DESC"
    ).all(this.tenantId) as SessionRow[]).map(rowToSession);

    let count = 0;
    const cutoffTime = Date.now() - cutoff;
    for (const s of deleted) {
      const deletedAt = s.config._deleted_at as string | undefined;
      if (deletedAt && new Date(deletedAt).getTime() < cutoffTime) {
        this.delete(s.id);
        count++;
      }
    }
    return count;
  }

  channelPort(sessionId: string): number {
    return 19200 + parseInt(sessionId.replace("s-", ""), 16) % 10000;
  }

  mergeConfig(sessionId: string, patch: Partial<SessionConfig>): void {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT config FROM sessions WHERE id = ? AND tenant_id = ?").get(sessionId, this.tenantId) as { config: string } | undefined;
      if (!row) return;
      const existing = safeParseConfig(row.config);
      const merged = { ...existing, ...patch };
      this.db.prepare("UPDATE sessions SET config = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
        .run(JSON.stringify(merged), new Date().toISOString(), sessionId, this.tenantId);
    });
  }

  search(query: string, opts?: { limit?: number }): Session[] {
    const limit = opts?.limit ?? 50;
    const pattern = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE tenant_id = ?
        AND (ticket LIKE ? OR summary LIKE ? OR repo LIKE ? OR id LIKE ?)
        AND status != 'deleting'
      ORDER BY created_at DESC LIMIT ?
    `).all(this.tenantId, pattern, pattern, pattern, pattern, limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  getChildren(parentId: string): Session[] {
    return this.list({ parent_id: parentId });
  }

  getGroups(): Array<{ name: string; created_at: string }> {
    return this.db.prepare(`
      SELECT name, created_at FROM groups
      WHERE tenant_id = ?
      ORDER BY name
    `).all(this.tenantId) as Array<{ name: string; created_at: string }>;
  }

  /** Return all group names — union of groups table + distinct session group_names, sorted. */
  getGroupNames(): string[] {
    const rows = this.db.prepare(`
      SELECT name FROM groups WHERE tenant_id = ?
      UNION
      SELECT DISTINCT group_name FROM sessions WHERE group_name IS NOT NULL AND tenant_id = ?
      ORDER BY 1
    `).all(this.tenantId, this.tenantId) as { name: string }[];
    return rows.map((r) => r.name);
  }

  createGroup(name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO groups (name, tenant_id, created_at) VALUES (?, ?, ?)").run(name, this.tenantId, now());
  }

  deleteGroup(name: string): void {
    this.db.prepare("DELETE FROM groups WHERE name = ? AND tenant_id = ?").run(name, this.tenantId);
    this.db.prepare("UPDATE sessions SET group_name = NULL WHERE group_name = ? AND tenant_id = ?").run(name, this.tenantId);
  }

  /** List sessions in 'deleting' status (soft-deleted). */
  listDeleted(): Session[] {
    return (this.db.prepare(
      "SELECT * FROM sessions WHERE tenant_id = ? AND status = 'deleting' ORDER BY updated_at DESC"
    ).all(this.tenantId) as SessionRow[]).map(rowToSession);
  }

  /** Generate a unique session ID (s-<6 hex chars>). Public for backward compat. */
  generateId(): string {
    while (true) {
      const id = `s-${randomBytes(3).toString("hex")}`;
      const row = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
      if (!row) return id;
    }
  }

  /** Check whether a channel port is in use by any running/waiting session. */
  isChannelPortAvailable(port: number, excludeSessionId?: string): boolean {
    const sessions = this.db.prepare(
      "SELECT id FROM sessions WHERE tenant_id = ? AND status IN ('running', 'waiting') AND id != ?"
    ).all(this.tenantId, excludeSessionId ?? "") as { id: string }[];
    return !sessions.some(s => this.channelPort(s.id) === port);
  }
}
