/**
 * ComputeStore port -- abstracts persistence of Compute targets.
 *
 * Owner: compute bounded context.
 *
 * Local binding: `ComputeRepository` (SQLite).
 * Control-plane binding: `ComputeRepository` against Postgres.
 * Test binding: in-memory `Map<string, Compute>`.
 *
 * Domain code MUST NOT import SQL drivers directly -- all persistence flows
 * through this port.
 */

import type { Compute, ComputeStatus, ComputeProviderName, CreateComputeOpts } from "../../types/index.js";

export interface ComputeListFilters {
  status?: ComputeStatus;
  provider?: ComputeProviderName;
  limit?: number;
}

export interface ComputeStore {
  /** Set the active tenant; subsequent reads/writes are scoped to this tenant. */
  setTenant(tenantId: string): void;

  /** Read the current tenant id. */
  getTenant(): string;

  /** Fetch a compute target by name (scoped to the active tenant). */
  get(name: string): Compute | null;

  /** Create a new compute target. */
  create(opts: CreateComputeOpts): Compute;

  /** Partially update a compute target. Returns the updated row or null. */
  update(name: string, fields: Partial<Compute>): Compute | null;

  /** Hard-delete a compute target. Returns true if removed. */
  delete(name: string): boolean;

  /** List compute targets for the active tenant, filtered. */
  list(filters?: ComputeListFilters): Compute[];
}
