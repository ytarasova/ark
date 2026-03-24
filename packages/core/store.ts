/**
 * SQLite store for sessions and events.
 *
 * Single-file database at ~/.ark/ark.db. Provides:
 * - Session CRUD with atomic CAS claiming
 * - Event logging (append-only audit trail)
 * - Message storage for agent↔human communication
 * - Auto-migration for schema changes
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "crypto";
import { mkdirSync, existsSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";

import {
  getContext, getDb as getDbFromContext, closeDb,
  createTestContext, setContext, resetContext,
  type StoreContext, type TestContext,
} from "./context.js";

// ── Paths ───────────────────────────────────────────────────────────────────
// Functions (not constants) so they respect ARK_TEST_DIR and setContext()
// at call time rather than freezing at import time.

// Migration shims — delegate to AppContext if available, fall back to legacy context
function appOrFallback(): { config: { arkDir: string; dbPath: string; tracksDir: string; worktreesDir: string } } | null {
  try {
    const { getApp } = require("./app.js") as typeof import("./app.js");
    return getApp();
  } catch {
    return null;
  }
}

export function ARK_DIR(): string {
  const app = appOrFallback();
  return app ? app.config.arkDir : getContext().arkDir;
}
export function DB_PATH(): string {
  const app = appOrFallback();
  return app ? app.config.dbPath : getContext().dbPath;
}
export function TRACKS_DIR(): string {
  const app = appOrFallback();
  return app ? app.config.tracksDir : getContext().tracksDir;
}
export function WORKTREES_DIR(): string {
  const app = appOrFallback();
  return app ? app.config.worktreesDir : getContext().worktreesDir;
}

// Re-export context utilities for tests
export { createTestContext, setContext, resetContext, closeDb, type TestContext };

// ── Types ───────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  ticket: string | null;      // DB column: jira_key — external ticket reference (Jira, GitHub issue, etc.)
  summary: string | null;     // DB column: jira_summary — task description
  repo: string | null;
  branch: string | null;
  compute_name: string | null;
  session_id: string | null; // tmux session name
  claude_session_id: string | null; // Claude UUID for --resume
  stage: string | null;
  status: string;
  flow: string;           // DB column: pipeline — flow definition name
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
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: number;
  track_id: string;
  type: string;
  stage: string | null;
  actor: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface Compute {
  name: string;              // unique identifier
  provider: string;          // "local" | "docker" | "ec2"
  status: string;            // "stopped" | "running" | "provisioning" | "destroyed"
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Database ────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

const _initialized = new WeakSet<Database>();

export function getDb(): Database {
  // Use AppContext if available
  const app = appOrFallback();
  if (app && (app as any).db) return (app as any).db;

  // Legacy path
  const db = getDbFromContext();
  if (!_initialized.has(db)) {
    _initialized.add(db); // mark BEFORE init to prevent recursion
    initSchema(db);
    // Ensure local compute exists (use db directly, not getDb)
    const row = db.prepare("SELECT name FROM compute WHERE name = 'local'").get();
    if (!row) {
      const ts = now();
      db.prepare(
        "INSERT OR IGNORE INTO compute (name, provider, status, config, created_at, updated_at) VALUES ('local', 'local', 'running', '{}', ?, ?)"
      ).run(ts, ts);
    }
  }
  return db;
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      jira_key TEXT,
      jira_summary TEXT,
      repo TEXT,
      branch TEXT,
      compute_name TEXT,
      session_id TEXT,
      claude_session_id TEXT,
      stage TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      pipeline TEXT NOT NULL DEFAULT 'default',
      agent TEXT,
      workdir TEXT,
      pr_url TEXT,
      pr_id TEXT,
      error TEXT,
      parent_id TEXT,
      fork_group TEXT,
      group_name TEXT,
      breakpoint_reason TEXT,
      attached_by TEXT,
      config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id TEXT NOT NULL,
      type TEXT NOT NULL,
      stage TEXT,
      actor TEXT,
      data TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_track ON events(track_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_group ON sessions(group_name);

    CREATE TABLE IF NOT EXISTS compute (
      name TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'stopped',
      config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_compute_provider ON compute(provider);
    CREATE INDEX IF NOT EXISTS idx_compute_status ON compute(status);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS groups (
      name TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS claude_sessions_cache (
      session_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      transcript_path TEXT NOT NULL,
      summary TEXT DEFAULT '',
      message_count INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT '',
      last_activity TEXT DEFAULT '',
      cached_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_claude_cache_activity ON claude_sessions_cache(last_activity DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_index USING fts5(
      session_id UNINDEXED,
      project,
      role,
      content,
      timestamp UNINDEXED
    );
  `);
}

// ── Session CRUD ────────────────────────────────────────────────────────────

export function generateId(): string {
  const db = getDb();
  while (true) {
    const id = `s-${randomBytes(3).toString("hex")}`;
    const row = db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
    if (!row) return id;
  }
}

export function createSession(opts: {
  ticket?: string | null;
  summary?: string | null;
  repo?: string | null;
  flow?: string | null;
  compute_name?: string | null;
  workdir?: string | null;
  group_name?: string | null;
  config?: Record<string, unknown>;
}): Session {
  const db = getDb();
  const id = generateId();
  const ts = now();
  const branch = opts.ticket
    ? `feat/${opts.ticket}-${(opts.summary ?? "work").toLowerCase().replace(/\s+/g, "-").slice(0, 30)}`
    : null;

  db.prepare(`
    INSERT INTO sessions (id, jira_key, jira_summary, repo, branch, compute_name,
      workdir, stage, status, pipeline, group_name, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, ?)
  `).run(
    id, opts.ticket ?? null, opts.summary ?? null, opts.repo ?? null,
    branch, opts.compute_name ?? null, opts.workdir ?? null,
    opts.flow ?? "default", opts.group_name ?? null,
    JSON.stringify(opts.config ?? {}), ts, ts,
  );

  logEvent(id, "session_created", {
    actor: "user",
    data: {
      ticket: opts.ticket, summary: opts.summary,
      repo: opts.repo, flow: opts.flow ?? "default",
      branch, workdir: opts.workdir, group_name: opts.group_name,
    },
  });

  return getSession(id)!;
}

export function getSession(id: string): Session | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  if (!row) return null;
  return { ...row, ticket: row.jira_key, summary: row.jira_summary, flow: row.pipeline, config: JSON.parse(row.config ?? "{}") };
}

export function listSessions(opts?: {
  status?: string;
  repo?: string;
  group_name?: string;
  parent_id?: string;
  limit?: number;
}): Session[] {
  const db = getDb();
  let sql = "SELECT * FROM sessions WHERE 1=1";
  const params: any[] = [];

  if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
  if (opts?.repo) { sql += " AND repo = ?"; params.push(opts.repo); }
  if (opts?.group_name) { sql += " AND group_name = ?"; params.push(opts.group_name); }
  if (opts?.parent_id) { sql += " AND parent_id = ?"; params.push(opts.parent_id); }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(opts?.limit ?? 100);

  return (db.prepare(sql).all(...params) as any[]).map((r) => ({
    ...r, ticket: r.jira_key, summary: r.jira_summary, flow: r.pipeline, config: JSON.parse(r.config ?? "{}"),
  }));
}

export function updateSession(id: string, fields: Partial<Session>): Session | null {
  const db = getDb();
  const updates: string[] = ["updated_at = ?"];
  const values: any[] = [now()];

  // Map TS field names to DB column names
  const fieldMap: Record<string, string> = { ticket: "jira_key", summary: "jira_summary", flow: "pipeline" };

  for (const [key, value] of Object.entries(fields)) {
    if (key === "id" || key === "created_at") continue;
    const col = fieldMap[key] ?? key;
    if (col === "config" && typeof value === "object") {
      updates.push("config = ?");
      values.push(JSON.stringify(value));
    } else {
      updates.push(`${col} = ?`);
      values.push(value ?? null);
    }
  }
  values.push(id);

  db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  return getSession(id);
}

/** Delete session DB rows only. Use session.deleteSessionAsync() for full cleanup. */
export function deleteSession(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM events WHERE track_id = ?").run(id);
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── Atomic claim (CAS) ─────────────────────────────────────────────────────

export function claimSession(
  id: string, expectedStatus: string, newStatus: string,
  extraFields?: Partial<Session>,
): boolean {
  const db = getDb();
  const updates: string[] = ["status = ?", "updated_at = ?"];
  const values: any[] = [newStatus, now()];

  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      updates.push(`${key} = ?`);
      values.push(key === "config" ? JSON.stringify(value) : value ?? null);
    }
  }
  values.push(id, expectedStatus);

  const result = db.prepare(
    `UPDATE sessions SET ${updates.join(", ")} WHERE id = ? AND status = ?`
  ).run(...values);
  return result.changes > 0;
}

// ── Events ──────────────────────────────────────────────────────────────────

export function logEvent(
  trackId: string, type: string,
  opts?: { stage?: string; actor?: string; data?: Record<string, unknown> },
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO events (track_id, type, stage, actor, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    trackId, type, opts?.stage ?? null, opts?.actor ?? null,
    opts?.data ? JSON.stringify(opts.data) : null, now(),
  );
}

export function getEvents(
  trackId: string, opts?: { type?: string; limit?: number },
): Event[] {
  const db = getDb();
  let sql = "SELECT * FROM events WHERE track_id = ?";
  const params: any[] = [trackId];
  if (opts?.type) { sql += " AND type = ?"; params.push(opts.type); }
  sql += " ORDER BY id ASC LIMIT ?";
  params.push(opts?.limit ?? 200);

  return (db.prepare(sql).all(...params) as any[]).map((r) => ({
    ...r, data: r.data ? JSON.parse(r.data) : null,
  }));
}

// ── Compute CRUD ────────────────────────────────────────────────────────────

/**
 * Ensure the singleton "local" compute exists. Called on DB init.
 */
export function ensureLocalCompute(): Compute {
  const existing = getCompute("local");
  if (existing) return existing;
  const db = getDb();
  const ts = now();
  db.prepare(`
    INSERT OR IGNORE INTO compute (name, provider, status, config, created_at, updated_at)
    VALUES ('local', 'local', 'running', '{}', ?, ?)
  `).run(ts, ts);
  return getCompute("local")!;
}

export function createCompute(opts: {
  name: string;
  provider?: string;
  config?: Record<string, unknown>;
}): Compute {
  const db = getDb();
  const ts = now();

  const provider = opts.provider ?? "local";
  const status = provider === "local" ? "running" : "stopped";

  db.prepare(`
    INSERT INTO compute (name, provider, status, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.name,
    provider,
    status,
    JSON.stringify(opts.config ?? {}),
    ts, ts,
  );

  return getCompute(opts.name)!;
}

export function getCompute(name: string): Compute | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM compute WHERE name = ?").get(name) as any;
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config ?? "{}") };
}

export function listCompute(opts?: {
  provider?: string;
  status?: string;
  limit?: number;
}): Compute[] {
  const db = getDb();
  let sql = "SELECT * FROM compute WHERE 1=1";
  const params: any[] = [];

  if (opts?.provider) { sql += " AND provider = ?"; params.push(opts.provider); }
  if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(opts?.limit ?? 100);

  return (db.prepare(sql).all(...params) as any[]).map((r) => ({
    ...r, config: JSON.parse(r.config ?? "{}"),
  }));
}

export function updateCompute(name: string, fields: Partial<Compute>): Compute | null {
  const db = getDb();
  const updates: string[] = ["updated_at = ?"];
  const values: any[] = [now()];

  for (const [key, value] of Object.entries(fields)) {
    if (key === "name" || key === "created_at") continue;
    if (key === "config" && typeof value === "object") {
      updates.push("config = ?");
      values.push(JSON.stringify(value));
    } else {
      updates.push(`${key} = ?`);
      values.push(value ?? null);
    }
  }
  values.push(name);

  db.prepare(`UPDATE compute SET ${updates.join(", ")} WHERE name = ?`).run(...values);
  return getCompute(name);
}

/**
 * Merge keys into a compute's config without replacing the whole object.
 * This is the safe way to update config - avoids read-then-spread races.
 */
export function mergeComputeConfig(name: string, patch: Record<string, unknown>): Compute | null {
  const compute = getCompute(name);
  if (!compute) return null;
  const merged = { ...compute.config, ...patch };
  return updateCompute(name, { config: merged });
}

export function deleteCompute(name: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM compute WHERE name = ?").run(name);
  return result.changes > 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getChildren(parentId: string): Session[] {
  return listSessions({ parent_id: parentId });
}

/** List all groups (union of groups table + session group_names). */
export function getGroups(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT name FROM groups
    UNION
    SELECT DISTINCT group_name FROM sessions WHERE group_name IS NOT NULL
    ORDER BY 1
  `).all() as any[];
  return rows.map((r) => r.name ?? r.group_name);
}

export function createGroup(name: string): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO groups (name, created_at) VALUES (?, ?)").run(name, now());
}

export function deleteGroup(name: string): void {
  const db = getDb();
  db.prepare("DELETE FROM groups WHERE name = ?").run(name);
  // Also unassign any sessions in this group
  db.prepare("UPDATE sessions SET group_name = NULL WHERE group_name = ?").run(name);
}

export function sessionChannelPort(sessionId: string): number {
  return 19200 + parseInt(sessionId.replace("s-", ""), 16) % 1000;
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface Message {
  id: number;
  session_id: string;
  role: string;    // "user" | "agent" | "system"
  content: string;
  type: string;    // "text" | "progress" | "question" | "completed" | "error"
  read: boolean;
  created_at: string;
}

export function addMessage(opts: {
  session_id: string;
  role: string;
  content: string;
  type?: string;
}): Message {
  const db = getDb();
  const ts = now();
  db.prepare(
    "INSERT INTO messages (session_id, role, content, type, read, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run(opts.session_id, opts.role, opts.content, opts.type ?? "text", ts);
  const row = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(opts.session_id) as any;
  return { ...row, read: !!row.read };
}

export function getMessages(sessionId: string, opts?: { limit?: number }): Message[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
  ).all(sessionId, opts?.limit ?? 50) as any[];
  return rows.reverse().map(r => ({ ...r, read: !!r.read }));
}

export function getUnreadCount(sessionId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND role = 'agent' AND read = 0"
  ).get(sessionId) as any;
  return row?.count ?? 0;
}

export function markMessagesRead(sessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE messages SET read = 1 WHERE session_id = ? AND read = 0").run(sessionId);
}
