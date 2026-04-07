/**
 * store.ts — backward-compatible shim.
 *
 * All real logic lives in:
 *   - repositories/ (SessionRepository, ComputeRepository, EventRepository, MessageRepository)
 *   - repositories/schema.ts (initSchema, seedLocalCompute)
 *   - context.ts (test context helpers)
 *   - ../types/index.ts (domain types)
 *
 * This file re-exports everything under the original API surface so that
 * existing callers (tests, CLI commands, session.ts, conductor.ts, etc.)
 * continue to work unchanged.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "crypto";

import {
  getContext, getDb as getDbFromContext, closeDb,
  createTestContext, setContext, resetContext,
  type StoreContext, type TestContext,
} from "./context.js";

import { initSchema as repoInitSchema, seedLocalCompute } from "./repositories/schema.js";

import type {
  SessionStatus, SessionConfig,
  ComputeStatus, ComputeProviderName, ComputeConfig,
  MessageRole, MessageType,
} from "../types/index.js";

// ── Re-export context utilities for tests ──────────────────────────────────
export { createTestContext, setContext, resetContext, closeDb, type TestContext };
export type { StoreContext };

// ── Types ──────────────────────────────────────────────────────────────────
// Re-export domain types that callers previously imported from store.ts

export interface Session {
  id: string;
  ticket: string | null;
  summary: string | null;
  repo: string | null;
  branch: string | null;
  compute_name: string | null;
  session_id: string | null;
  claude_session_id: string | null;
  stage: string | null;
  status: SessionStatus;
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
  name: string;
  provider: ComputeProviderName;
  status: ComputeStatus;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
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

export interface Message {
  id: number;
  session_id: string;
  role: MessageRole;
  content: string;
  type: MessageType;
  read: boolean;
  created_at: string;
}

// ── Safe parsing ────────────────────────────────────────────────────────────

export function safeParseConfig(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null) return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw ?? "{}")); }
  catch { return {}; }
}

export function rowToSession(row: SessionRow): Session {
  return {
    ...row,
    status: row.status as SessionStatus,
    config: safeParseConfig(row.config),
  };
}

// ── App-level overrides ────────────────────────────────────────────────────
// setAppStore/clearAppStore are still called by AppContext.boot()/shutdown().
// They wire the DB and paths so getDb() / ARK_DIR() etc. work without
// requiring a circular import of app.ts at call time.

let _appConfig: { arkDir: string; dbPath: string; tracksDir: string; worktreesDir: string } | null = null;
let _appDb: Database | null = null;

export function setAppStore(db: Database, config: typeof _appConfig): void {
  _appDb = db;
  _appConfig = config;
}

export function clearAppStore(): void {
  _appDb = null;
  _appConfig = null;
}

// ── Paths ──────────────────────────────────────────────────────────────────

export function ARK_DIR(): string {
  return _appConfig ? _appConfig.arkDir : getContext().arkDir;
}
export function DB_PATH(): string {
  return _appConfig ? _appConfig.dbPath : getContext().dbPath;
}
export function TRACKS_DIR(): string {
  return _appConfig ? _appConfig.tracksDir : getContext().tracksDir;
}
export function WORKTREES_DIR(): string {
  return _appConfig ? _appConfig.worktreesDir : getContext().worktreesDir;
}

// ── Database ───────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

const _initialized = new WeakSet<Database>();

export function getDb(): Database {
  if (_appDb) return _appDb;

  const db = getDbFromContext();
  if (!_initialized.has(db)) {
    _initialized.add(db);
    initSchema(db);
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

export function initSchema(db: Database): void {
  repoInitSchema(db);
}

// ── Session CRUD ───────────────────────────────────────────────────────────

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
    INSERT INTO sessions (id, ticket, summary, repo, branch, compute_name,
      workdir, stage, status, flow, group_name, config, created_at, updated_at)
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
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!row) return null;
  return rowToSession(row);
}

export function listSessions(opts?: {
  status?: string;
  repo?: string;
  group_name?: string;
  parent_id?: string;
  groupPrefix?: string;
  limit?: number;
}): Session[] {
  const db = getDb();
  let sql = "SELECT * FROM sessions WHERE status != 'deleting'";
  const params: any[] = [];

  if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }
  if (opts?.repo) { sql += " AND repo = ?"; params.push(opts.repo); }
  if (opts?.group_name) { sql += " AND group_name = ?"; params.push(opts.group_name); }
  if (opts?.parent_id) { sql += " AND parent_id = ?"; params.push(opts.parent_id); }
  if (opts?.groupPrefix) { sql += " AND group_name LIKE ?"; params.push(opts.groupPrefix + "%"); }

  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(opts?.limit ?? 100);

  return (db.prepare(sql).all(...params) as SessionRow[]).map(rowToSession);
}

const SESSION_COLUMNS = new Set([
  "ticket", "summary", "repo", "branch", "compute_name", "session_id",
  "claude_session_id", "stage", "status", "flow", "agent", "workdir",
  "pr_url", "pr_id", "error", "parent_id", "fork_group", "group_name",
  "breakpoint_reason", "attached_by", "config", "updated_at",
]);

const COMPUTE_COLUMNS = new Set([
  "provider", "status", "config", "updated_at",
]);

export function updateSession(id: string, fields: Partial<Session>): Session | null {
  const db = getDb();
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

  db.prepare(`UPDATE sessions SET ${updates.join(", ")} WHERE id = ?`).run(...values);
  return getSession(id);
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM events WHERE track_id = ?").run(id);
  const result = db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  return result.changes > 0;
}

export function softDeleteSession(id: string): boolean {
  const session = getSession(id);
  if (!session) return false;
  const config = { ...session.config, _pre_delete_status: session.status, _deleted_at: new Date().toISOString() };
  updateSession(id, { status: "deleting", config });
  return true;
}

export function undeleteSession(id: string): Session | null {
  const session = getSession(id);
  if (!session || session.status !== "deleting") return null;
  const prevStatus = (session.config._pre_delete_status as SessionStatus) || "pending";
  const { _pre_delete_status, _deleted_at, ...cleanConfig } = session.config;
  updateSession(id, { status: prevStatus, config: cleanConfig });
  return getSession(id);
}

export function listDeletedSessions(): Session[] {
  const db = getDb();
  return (db.prepare("SELECT * FROM sessions WHERE status = 'deleting' ORDER BY updated_at DESC").all() as SessionRow[]).map(rowToSession);
}

export function purgeExpiredDeletes(ttlSeconds: number = 90): string[] {
  const deleted = listDeletedSessions();
  const purged: string[] = [];
  const cutoff = Date.now() - ttlSeconds * 1000;

  for (const s of deleted) {
    const deletedAt = s.config._deleted_at as string | undefined;
    if (deletedAt && new Date(deletedAt).getTime() < cutoff) {
      deleteSession(s.id);
      purged.push(s.id);
    }
  }
  return purged;
}

// ── Atomic claim (CAS) ────────────────────────────────────────────────────

export function claimSession(
  id: string, expectedStatus: string, newStatus: string,
  extraFields?: Partial<Session>,
): boolean {
  const db = getDb();
  const updates: string[] = ["status = ?", "updated_at = ?"];
  const values: any[] = [newStatus, now()];

  if (extraFields) {
    for (const [key, value] of Object.entries(extraFields)) {
      if (!SESSION_COLUMNS.has(key)) continue;
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

// ── Events ─────────────────────────────────────────────────────────────────

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

  return (db.prepare(sql).all(...params) as any[]).map((row: any) => ({
    ...row,
    data: row.data ? JSON.parse(row.data) : null,
  }));
}

// ── Compute CRUD ───────────────────────────────────────────────────────────

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
  let providerInstance: any = null;
  try {
    const { getProvider } = require("../compute/index.js");
    providerInstance = getProvider(opts.provider ?? "local");
  } catch {}
  const status = providerInstance?.initialStatus ?? (provider === "local" ? "running" : "stopped");

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
  const row = db.prepare("SELECT * FROM compute WHERE name = ?").get(name) as any | undefined;
  if (!row) return null;
  return {
    ...row,
    provider: row.provider as ComputeProviderName,
    status: row.status as ComputeStatus,
    config: safeParseConfig(row.config),
  };
}

export function listCompute(opts?: {
  provider?: string;
  status?: string;
  limit?: number;
}): Compute[] {
  ensureLocalCompute();
  const db = getDb();
  let sql = "SELECT * FROM compute WHERE 1=1";
  const params: any[] = [];

  if (opts?.provider) { sql += " AND provider = ?"; params.push(opts.provider); }
  if (opts?.status) { sql += " AND status = ?"; params.push(opts.status); }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(opts?.limit ?? 100);

  return (db.prepare(sql).all(...params) as any[]).map((row: any) => ({
    ...row,
    provider: row.provider as ComputeProviderName,
    status: row.status as ComputeStatus,
    config: safeParseConfig(row.config),
  }));
}

export function updateCompute(name: string, fields: Partial<Compute>): Compute | null {
  const db = getDb();
  const updates: string[] = ["updated_at = ?"];
  const values: any[] = [now()];

  for (const [key, value] of Object.entries(fields)) {
    if (key === "name" || key === "created_at") continue;
    if (!COMPUTE_COLUMNS.has(key)) continue;
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

export function mergeComputeConfig(name: string, patch: Record<string, unknown>): Compute | null {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT config FROM compute WHERE name = ?").get(name) as { config: string } | undefined;
    if (!row) return;
    const existing = safeParseConfig(row.config);
    const merged = { ...existing, ...patch };
    db.prepare("UPDATE compute SET config = ?, updated_at = ? WHERE name = ?")
      .run(JSON.stringify(merged), new Date().toISOString(), name);
  })();
  return getCompute(name);
}

export function mergeSessionConfig(sessionId: string, patch: Record<string, unknown>): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare("SELECT config FROM sessions WHERE id = ?").get(sessionId) as { config: string } | undefined;
    if (!row) return;
    const existing = safeParseConfig(row.config);
    const merged = { ...existing, ...patch };
    db.prepare("UPDATE sessions SET config = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(merged), new Date().toISOString(), sessionId);
  })();
}

export function deleteCompute(name: string): boolean {
  if (name === "local") return false;
  const db = getDb();
  const result = db.prepare("DELETE FROM compute WHERE name = ?").run(name);
  return result.changes > 0;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function getChildren(parentId: string): Session[] {
  return listSessions({ parent_id: parentId });
}

export function getGroups(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT name FROM groups
    UNION
    SELECT DISTINCT group_name FROM sessions WHERE group_name IS NOT NULL
    ORDER BY 1
  `).all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function createGroup(name: string): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO groups (name, created_at) VALUES (?, ?)").run(name, now());
}

export function deleteGroup(name: string): void {
  const db = getDb();
  db.prepare("DELETE FROM groups WHERE name = ?").run(name);
  db.prepare("UPDATE sessions SET group_name = NULL WHERE group_name = ?").run(name);
}

export function sessionChannelPort(sessionId: string): number {
  return 19200 + parseInt(sessionId.replace("s-", ""), 16) % 10000;
}

export function isChannelPortAvailable(port: number, excludeSessionId?: string): boolean {
  const db = getDb();
  const sessions = db.prepare(
    "SELECT id FROM sessions WHERE status IN ('running', 'waiting') AND id != ?"
  ).all(excludeSessionId ?? "") as any[];
  return !sessions.some(s => sessionChannelPort(s.id) === port);
}

// ── Messages ───────────────────────────────────────────────────────────────

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
  return {
    ...row,
    role: row.role as MessageRole,
    type: row.type as MessageType,
    read: !!row.read,
  };
}

export function getMessages(sessionId: string, opts?: { limit?: number }): Message[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?"
  ).all(sessionId, opts?.limit ?? 50) as any[];
  return rows.reverse().map((row: any) => ({
    ...row,
    role: row.role as MessageRole,
    type: row.type as MessageType,
    read: !!row.read,
  }));
}

export function getUnreadCount(sessionId: string): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM messages WHERE session_id = ? AND role = 'agent' AND read = 0"
  ).get(sessionId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function markMessagesRead(sessionId: string): void {
  const db = getDb();
  db.prepare("UPDATE messages SET read = 1 WHERE session_id = ? AND read = 0").run(sessionId);
}
