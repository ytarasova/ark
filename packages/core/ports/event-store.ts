/**
 * EventStore port -- durable append-only log of session-scoped events.
 *
 * Owner: session bounded context.
 *
 * Distinct from `EventBus`: the bus is in-memory pub/sub; the store is a
 * durable log queried for replay/UI history.
 *
 * Local binding: `EventRepository` (SQLite).
 * Control-plane binding: `EventRepository` against Postgres.
 * Test binding: in-memory array.
 *
 * ## Immutability semantics
 *
 * `log(trackId, type, opts)` is the ONLY append path. Callers must NOT
 * mutate rows post-write. Query-only paths (`list`) never mutate.
 *
 * `deleteForTrack(trackId)` is a **session-lifecycle cascade**, not an audit
 * tampering operation. It removes events tied to a session when that session
 * is deleted by its owner. This is NOT suitable for any compliance-grade
 * audit log that must survive session deletion -- if that requirement
 * emerges, introduce a separate `ComplianceAuditStore` port without this
 * method, or refuse to call `deleteForTrack` in hosted-mode policy.
 *
 * Flagged as a known gap in docs/2026-04-19-PROGRESS_CHECK.md item #14.
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

  /** Append an event (audit trail) for a given track (session / group) id. */
  log(trackId: string, type: string, opts?: EventLogOpts): void;

  /** List events for a track, optionally filtered by type. Default limit 200. */
  list(trackId: string, opts?: EventListOpts): Event[];

  /**
   * Remove every event for a track. Session-delete cascade only.
   * See port-level doc for immutability semantics.
   */
  deleteForTrack(trackId: string): void;
}
