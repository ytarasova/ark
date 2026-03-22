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
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Paths ───────────────────────────────────────────────────────────────────

export const ARK_DIR = join(homedir(), ".ark");
export const DB_PATH = join(ARK_DIR, "ark.db");
export const TRACKS_DIR = join(ARK_DIR, "tracks");
export const WORKTREES_DIR = join(ARK_DIR, "worktrees");

// ── Types ───────────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  jira_key: string | null;
  jira_summary: string | null;
  repo: string | null;
  branch: string | null;
  compute_name: string | null;
  session_id: string | null; // tmux session name
  claude_session_id: string | null; // Claude UUID for --resume
  stage: string | null;
  status: string;
  pipeline: string;
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

export interface Host {
  name: string;              // unique identifier
  provider: string;          // "local" | "docker" | "ec2"
  status: string;            // "stopped" | "running" | "provisioning" | "destroyed"
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ── Database ────────────────────────────────────────────────────────────────

let _db: Database | null = null;

function now(): string {
  return new Date().toISOString();
}

function ensureDirs(): void {
  for (const dir of [ARK_DIR, TRACKS_DIR, WORKTREES_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

export function getDb(): Database {
  if (_db) return _db;
  ensureDirs();
  _db = new Database(DB_PATH);
  _db.run("PRAGMA journal_mode = WAL");
  _db.run("PRAGMA foreign_keys = ON");
  _db.run("PRAGMA busy_timeout = 10000");
  initSchema(_db);
  return _db;
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

    CREATE TABLE IF NOT EXISTS hosts (
      name TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL DEFAULT 'stopped',
      config TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_hosts_provider ON hosts(provider);
    CREATE INDEX IF NOT EXISTS idx_hosts_status ON hosts(status);
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
  jira_key?: string | null;
  jira_summary?: string | null;
  repo?: string | null;
  pipeline?: string | null;
  compute_name?: string | null;
  workdir?: string | null;
  group_name?: string | null;
  config?: Record<string, unknown>;
}): Session {
  const db = getDb();
  const id = generateId();
  const ts = now();
  const branch = opts.jira_key
    ? `feat/${opts.jira_key}-${(opts.jira_summary ?? "work").toLowerCase().replace(/\s+/g, "-").slice(0, 30)}`
    : null;

  db.prepare(`
    INSERT INTO sessions (id, jira_key, jira_summary, repo, branch, compute_name,
      workdir, stage, status, pipeline, group_name, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?, ?, ?)
  `).run(
    id, opts.jira_key ?? null, opts.jira_summary ?? null, opts.repo ?? null,
    branch, opts.compute_name ?? null, opts.workdir ?? null,
    opts.pipeline ?? "default", opts.group_name ?? null,
    JSON.stringify(opts.config ?? {}), ts, ts,
  );

  logEvent(id, "session_created", {
    actor: "user",
    data: {
      jira_key: opts.jira_key, jira_summary: opts.jira_summary,
      repo: opts.repo, pipeline: opts.pipeline ?? "default",
      branch, workdir: opts.workdir, group_name: opts.group_name,
    },
  });

  return getSession(id)!;
}

export function getSession(id: string): Session | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as any;
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config ?? "{}") };
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
    ...r, config: JSON.parse(r.config ?? "{}"),
  }));
}

export function updateSession(id: string, fields: Partial<Session>): Session | null {
  const db = getDb();
  const updates: string[] = ["updated_at = ?"];
  const values: any[] = [now()];

  for (const [key, value] of Object.entries(fields)) {
    if (key === "id" || key === "created_at") continue;
    if (key === "config" && typeof value === "object") {
      updates.push("config = ?");
      values.push(JSON.stringify(value));
    } else {
      updates.push(`${key} = ?`);
      values.push(value ?? null);
    }
  }
  values.push(id);

  db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  return getSession(id);
}

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

// ── Host CRUD ───────────────────────────────────────────────────────────────

export function createHost(opts: {
  name: string;
  provider?: string;
  config?: Record<string, unknown>;
}): Host {
  const db = getDb();
  const ts = now();

  const provider = opts.provider ?? "local";
  const status = provider === "local" ? "running" : "stopped";

  db.prepare(`
    INSERT INTO hosts (name, provider, status, config, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    opts.name,
    provider,
    status,
    JSON.stringify(opts.config ?? {}),
    ts, ts,
  );

  return getHost(opts.name)!;
}

export function getHost(name: string): Host | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM hosts WHERE name = ?").get(name) as any;
  if (!row) return null;
  return { ...row, config: JSON.parse(row.config ?? "{}") };
}

export function listHosts(opts?: {
  provider?: string;
  status?: string;
  limit?: number;
}): Host[] {
  const db = getDb();
  let sql = "SELECT * FROM hosts WHERE 1=1";
  const params: any[] = [];

  if (opts?.provider) { sql += " AND provider = ?"; params.push(opts.provider); }
  if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(opts?.limit ?? 100);

  return (db.prepare(sql).all(...params) as any[]).map((r) => ({
    ...r, config: JSON.parse(r.config ?? "{}"),
  }));
}

export function updateHost(name: string, fields: Partial<Host>): Host | null {
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

  db.prepare(`UPDATE hosts SET ${updates.join(", ")} WHERE name = ?`).run(...values);
  return getHost(name);
}

export function deleteHost(name: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM hosts WHERE name = ?").run(name);
  return result.changes > 0;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getChildren(parentId: string): Session[] {
  return listSessions({ parent_id: parentId });
}

export function getGroups(): string[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT DISTINCT group_name FROM sessions WHERE group_name IS NOT NULL ORDER BY group_name"
  ).all() as any[];
  return rows.map((r) => r.group_name);
}
