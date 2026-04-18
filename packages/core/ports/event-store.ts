/**
 * EventStore port -- persistent audit log of session-scoped events.
 *
 * Owner: session bounded context.
 *
 * Distinct from `EventBus`: the bus is in-memory pub/sub; the store is a
 * durable append-only log queried for replay/UI history.
 *
 * Local binding: `EventRepository` (SQLite).
 * Control-plane binding: `EventRepository` against Postgres.
 * Test binding: in-memory array.
 */

import type { Event } from "../../types/index.js";

export interface EventLogOpts {
  stage?: string;
  actor?: string;
  data?: Record<string, unknown>;
}

export interface EventListOpts {
  type?: string;
  limit?: number;
}

export interface EventStore {
  /** Set the active tenant; subsequent reads/writes are scoped to this tenant. */
  setTenant(tenantId: string): void;

  /** Read the current tenant id. */
  getTenant(): string;

  /** Append an audit event for a given track (session / group) id. */
  log(trackId: string, type: string, opts?: EventLogOpts): void;

  /** List events for a track, optionally filtered by type. Default limit 200. */
  list(trackId: string, opts?: EventListOpts): Event[];

  /** Remove every event for a track (used on session delete). */
  deleteForTrack(trackId: string): void;
}
