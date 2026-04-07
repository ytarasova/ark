import { Database } from "bun:sqlite";
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
  "breakpoint_reason", "attached_by", "config", "updated_at",
]);

// ── Repository ──────────────────────────────────────────────────────────────

export class SessionRepository {
  constructor(private db: Database) {}

  create(opts: CreateSessionOpts): Session {
    const id = this.generateId();
    const ts = now();
    const branch = opts.ticket
      ? `feat/${opts.ticket}-${(opts.summary ?? "work").toLowerCase().replace(/\s+/g, "-").slice(0, 30)}`
      : null;

    this.db.prepare(`
      INSERT INTO sessions (id, ticket, summary, repo, branch, compute_name,
        workdir, stage, status, flow, agent, group_name, config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      id, opts.ticket ?? null, opts.summary ?? null, opts.repo ?? null,
      branch, opts.compute_name ?? null, opts.workdir ?? null,
      opts.flow ?? "default", opts.agent ?? null, opts.group_name ?? null,
      JSON.stringify(opts.config ?? {}), ts, ts,
    );

    return this.get(id)!;
  }

  get(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  list(filters?: SessionListFilters): Session[] {
    let sql = "SELECT * FROM sessions WHERE status != 'deleting'";
    const params: any[] = [];

    if (filters?.status) { sql += " AND status = ?"; params.push(filters.status); }
    if (filters?.repo) { sql += " AND repo = ?"; params.push(filters.repo); }
    if (filters?.group_name) { sql += " AND group_name = ?"; params.push(filters.group_name); }
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
    values.push(id);

    this.db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    return this.get(id);
  }

  delete(id: string): boolean {
    this.db.prepare("DELETE FROM events WHERE track_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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
    values.push(id, expected);

    const result = this.db.prepare(
      `UPDATE sessions SET ${updates.join(", ")} WHERE id = ? AND status = ?`
    ).run(...values);
    return result.changes > 0;
  }

  purgeDeleted(olderThanMs?: number): number {
    const cutoff = olderThanMs ?? 90_000;
    const deleted = (this.db.prepare(
      "SELECT * FROM sessions WHERE status = 'deleting' ORDER BY updated_at DESC"
    ).all() as SessionRow[]).map(rowToSession);

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
      const row = this.db.prepare("SELECT config FROM sessions WHERE id = ?").get(sessionId) as { config: string } | undefined;
      if (!row) return;
      const existing = safeParseConfig(row.config);
      const merged = { ...existing, ...patch };
      this.db.prepare("UPDATE sessions SET config = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(merged), new Date().toISOString(), sessionId);
    })();
  }

  search(query: string, opts?: { limit?: number }): Session[] {
    const limit = opts?.limit ?? 50;
    const pattern = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE (ticket LIKE ? OR summary LIKE ? OR repo LIKE ? OR id LIKE ?)
        AND status != 'deleting'
      ORDER BY created_at DESC LIMIT ?
    `).all(pattern, pattern, pattern, pattern, limit) as SessionRow[];
    return rows.map(rowToSession);
  }

  getChildren(parentId: string): Session[] {
    return this.list({ parent_id: parentId });
  }

  getGroups(): Array<{ name: string; created_at: string }> {
    return this.db.prepare(`
      SELECT name, created_at FROM groups
      ORDER BY name
    `).all() as Array<{ name: string; created_at: string }>;
  }

  /** Return all group names — union of groups table + distinct session group_names, sorted. */
  getGroupNames(): string[] {
    const rows = this.db.prepare(`
      SELECT name FROM groups
      UNION
      SELECT DISTINCT group_name FROM sessions WHERE group_name IS NOT NULL
      ORDER BY 1
    `).all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  createGroup(name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO groups (name, created_at) VALUES (?, ?)").run(name, now());
  }

  deleteGroup(name: string): void {
    this.db.prepare("DELETE FROM groups WHERE name = ?").run(name);
    this.db.prepare("UPDATE sessions SET group_name = NULL WHERE group_name = ?").run(name);
  }

  /** List sessions in 'deleting' status (soft-deleted). */
  listDeleted(): Session[] {
    return (this.db.prepare(
      "SELECT * FROM sessions WHERE status = 'deleting' ORDER BY updated_at DESC"
    ).all() as SessionRow[]).map(rowToSession);
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
      "SELECT id FROM sessions WHERE status IN ('running', 'waiting') AND id != ?"
    ).all(excludeSessionId ?? "") as { id: string }[];
    return !sessions.some(s => this.channelPort(s.id) === port);
  }
}
