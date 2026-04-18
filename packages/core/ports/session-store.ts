/**
 * SessionStore port -- abstracts persistence of Session aggregates.
 *
 * Owner: session bounded context.
 *
 * Local binding: `SessionRepository` (SQLite/Postgres).
 * Control-plane binding: `SessionRepository` against Postgres (tenant row-filtering).
 * Test binding: in-memory `Map<string, Session>`.
 *
 * Domain code MUST NOT import `bun:sqlite` or `better-sqlite3` directly -- all
 * persistence flows through this port.
 */

import type { Session, CreateSessionOpts, SessionListFilters } from "../../types/index.js";

export interface SessionStore {
  /** Set the active tenant; subsequent reads/writes are scoped to this tenant. */
  setTenant(tenantId: string): void;

  /** Read the current tenant id. */
  getTenant(): string;

  /** Fetch a single session by id (scoped to the active tenant). */
  get(id: string): Session | null;

  /** Create a new session. Returns the persisted session with generated id. */
  create(opts: CreateSessionOpts): Session;

  /** Partially update a session. Returns the updated session or null if missing. */
  update(id: string, fields: Partial<Session>): Session | null;

  /** Hard-delete a session. Returns true if a row was removed. */
  delete(id: string): boolean;

  /** List sessions for the active tenant, filtered. */
  list(filters?: SessionListFilters): Session[];

  /** List sessions with status = 'deleting' (reserved for cleanup). */
  listDeleted(): Session[];

  /** Deterministic channel port derived from the session id. */
  channelPort(sessionId: string): number;
}
