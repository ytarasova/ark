/**
 * store.ts — backward-compatible delegation shim.
 *
 * Zero SQL in this file. Every data operation delegates to a repository
 * accessed via lazy per-Database repo instances.
 *
 * Repositories:
 *   - repositories/session.ts  (SessionRepository)
 *   - repositories/compute.ts  (ComputeRepository)
 *   - repositories/event.ts    (EventRepository)
 *   - repositories/message.ts  (MessageRepository)
 *   - repositories/schema.ts   (initSchema, seedLocalCompute)
 *
 * Context:
 *   - context.ts  (test context helpers, getDb for legacy callers)
 */

import { Database } from "bun:sqlite";

import {
  getContext, getDb as getDbFromContext, closeDb,
  createTestContext, setContext, resetContext,
  type StoreContext, type TestContext,
} from "./context.js";

import { initSchema as repoInitSchema, seedLocalCompute } from "./repositories/schema.js";
import { SessionRepository } from "./repositories/session.js";
import { ComputeRepository } from "./repositories/compute.js";
import { EventRepository } from "./repositories/event.js";
import { MessageRepository } from "./repositories/message.js";

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
// setAppStore/clearAppStore are called by AppContext.boot()/shutdown().
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

const _initialized = new WeakSet<Database>();

/** Return the current Database handle. Initializes schema on first use. */
export function getDb(): Database {
  if (_appDb) return _appDb;

  const db = getDbFromContext();
  if (!_initialized.has(db)) {
    _initialized.add(db);
    initSchema(db);
    seedLocalCompute(db);
  }
  return db;
}

export function initSchema(db: Database): void {
  repoInitSchema(db);
}

// ── Lazy repository accessors ──────────────────────────────────────────────
// Each test gets a fresh DB via context.ts, so we cache per-Database instance.

const _repoCache = new WeakMap<Database, {
  sessions: SessionRepository;
  computes: ComputeRepository;
  events: EventRepository;
  messages: MessageRepository;
}>();

function repos() {
  const db = getDb();
  let cached = _repoCache.get(db);
  if (!cached) {
    cached = {
      sessions: new SessionRepository(db),
      computes: new ComputeRepository(db),
      events: new EventRepository(db),
      messages: new MessageRepository(db),
    };
    _repoCache.set(db, cached);
  }
  return cached;
}

// ── Session CRUD ───────────────────────────────────────────────────────────

export function generateId(): string {
  return repos().sessions.generateId();
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
  const session = repos().sessions.create(opts as any) as Session;

  // Log session_created event (the repo does not do this — store.ts always did)
  logEvent(session.id, "session_created", {
    actor: "user",
    data: {
      ticket: opts.ticket, summary: opts.summary,
      repo: opts.repo, flow: opts.flow ?? "default",
      branch: session.branch, workdir: opts.workdir, group_name: opts.group_name,
    },
  });

  return session;
}

export function getSession(id: string): Session | null {
  return repos().sessions.get(id) as Session | null;
}

export function listSessions(opts?: {
  status?: string;
  repo?: string;
  group_name?: string;
  parent_id?: string;
  groupPrefix?: string;
  limit?: number;
}): Session[] {
  // The repo supports most filters natively. groupPrefix is not supported,
  // so fetch a broader set and filter in memory when needed.
  if (opts?.groupPrefix) {
    const all = repos().sessions.list({
      status: opts.status,
      repo: opts.repo,
      parent_id: opts.parent_id,
      limit: opts.limit,
    } as any) as Session[];
    return all.filter(s => s.group_name && s.group_name.startsWith(opts.groupPrefix!));
  }
  return repos().sessions.list(opts as any) as Session[];
}

export function updateSession(id: string, fields: Partial<Session>): Session | null {
  return repos().sessions.update(id, fields as any) as Session | null;
}

export function deleteSession(id: string): boolean {
  return repos().sessions.delete(id);
}

export function softDeleteSession(id: string): boolean {
  return repos().sessions.softDelete(id);
}

export function undeleteSession(id: string): Session | null {
  return repos().sessions.undelete(id) as Session | null;
}

export function listDeletedSessions(): Session[] {
  return repos().sessions.listDeleted() as Session[];
}

export function purgeExpiredDeletes(ttlSeconds: number = 90): string[] {
  const deleted = listDeletedSessions();
  const purged: string[] = [];
  const cutoff = Date.now() - ttlSeconds * 1000;

  for (const s of deleted) {
    const deletedAt = s.config._deleted_at as string | undefined;
    if (deletedAt && new Date(deletedAt).getTime() < cutoff) {
      repos().sessions.delete(s.id);
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
  return repos().sessions.claim(id, expectedStatus as any, newStatus as any, extraFields as any);
}

// ── Events ─────────────────────────────────────────────────────────────────

export function logEvent(
  trackId: string, type: string,
  opts?: { stage?: string; actor?: string; data?: Record<string, unknown> },
): void {
  repos().events.log(trackId, type, opts);
}

export function getEvents(
  trackId: string, opts?: { type?: string; limit?: number },
): Event[] {
  return repos().events.list(trackId, opts) as Event[];
}

// ── Compute CRUD ───────────────────────────────────────────────────────────

export function ensureLocalCompute(): Compute {
  const existing = repos().computes.get("local");
  if (existing) return existing as Compute;
  seedLocalCompute(getDb());
  return repos().computes.get("local")! as Compute;
}

export function createCompute(opts: {
  name: string;
  provider?: string;
  config?: Record<string, unknown>;
}): Compute {
  return repos().computes.create(opts as any) as Compute;
}

export function getCompute(name: string): Compute | null {
  return repos().computes.get(name) as Compute | null;
}

export function listCompute(opts?: {
  provider?: string;
  status?: string;
  limit?: number;
}): Compute[] {
  ensureLocalCompute();
  return repos().computes.list(opts as any) as Compute[];
}

export function updateCompute(name: string, fields: Partial<Compute>): Compute | null {
  return repos().computes.update(name, fields as any) as Compute | null;
}

export function mergeComputeConfig(name: string, patch: Record<string, unknown>): Compute | null {
  return repos().computes.mergeConfig(name, patch as any) as Compute | null;
}

export function mergeSessionConfig(sessionId: string, patch: Record<string, unknown>): void {
  repos().sessions.mergeConfig(sessionId, patch as any);
}

export function deleteCompute(name: string): boolean {
  return repos().computes.delete(name);
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function getChildren(parentId: string): Session[] {
  return repos().sessions.getChildren(parentId) as Session[];
}

export function getGroups(): string[] {
  return repos().sessions.getGroupNames();
}

export function createGroup(name: string): void {
  repos().sessions.createGroup(name);
}

export function deleteGroup(name: string): void {
  repos().sessions.deleteGroup(name);
}

export function sessionChannelPort(sessionId: string): number {
  return repos().sessions.channelPort(sessionId);
}

export function isChannelPortAvailable(port: number, excludeSessionId?: string): boolean {
  return repos().sessions.isChannelPortAvailable(port, excludeSessionId);
}

// ── Messages ───────────────────────────────────────────────────────────────

export function addMessage(opts: {
  session_id: string;
  role: string;
  content: string;
  type?: string;
}): Message {
  return repos().messages.send(opts.session_id, opts.role as any, opts.content, opts.type as any) as Message;
}

export function getMessages(sessionId: string, opts?: { limit?: number }): Message[] {
  return repos().messages.list(sessionId, opts) as Message[];
}

export function getUnreadCount(sessionId: string): number {
  return repos().messages.unreadCount(sessionId);
}

export function markMessagesRead(sessionId: string): void {
  repos().messages.markRead(sessionId);
}
