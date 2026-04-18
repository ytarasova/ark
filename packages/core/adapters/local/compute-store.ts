/**
 * LocalComputeStore adapter -- stub.
 *
 * In Slice 1 this will delegate to the existing `ComputeRepository`.
 */

import type { ComputeStore, ComputeListFilters } from "../../ports/compute-store.js";
import type { Compute, CreateComputeOpts } from "../../../types/index.js";

const NOT_MIGRATED = new Error("LocalComputeStore: not migrated yet -- Slice 1");

export class LocalComputeStore implements ComputeStore {
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
