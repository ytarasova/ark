/**
 * ControlPlaneComputeStore adapter -- stub.
 *
 * Hosted Postgres-backed ComputeRepository. Slice 1 migration.
 */

import type { ComputeStore, ComputeListFilters } from "../../ports/compute-store.js";
import type { Compute, CreateComputeOpts } from "../../../types/index.js";

const NOT_MIGRATED = new Error("ControlPlaneComputeStore: not migrated yet -- Slice 1");

export class ControlPlaneComputeStore implements ComputeStore {
  setTenant(_tenantId: string): void {
    throw NOT_MIGRATED;
  }
  getTenant(): string {
    throw NOT_MIGRATED;
  }
  get(_name: string): Compute | null {
    throw NOT_MIGRATED;
  }
  create(_opts: CreateComputeOpts): Compute {
    throw NOT_MIGRATED;
  }
  update(_name: string, _fields: Partial<Compute>): Compute | null {
    throw NOT_MIGRATED;
  }
  delete(_name: string): boolean {
    throw NOT_MIGRATED;
  }
  list(_filters?: ComputeListFilters): Compute[] {
    throw NOT_MIGRATED;
  }
}
