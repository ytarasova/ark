/**
 * MapSecretStore adapter -- stub.
 *
 * Slice 5: in-memory map seeded by the test fixture instead of reading
 * `process.env`.
 */

import type { SecretStore } from "../../ports/secret-store.js";

const NOT_MIGRATED = new Error("MapSecretStore: not migrated yet -- Slice 5");

export class MapSecretStore implements SecretStore {
  get(_key: string): string | null {
    throw NOT_MIGRATED;
  }
  require(_key: string): string {
    throw NOT_MIGRATED;
  }
  has(_key: string): boolean {
    throw NOT_MIGRATED;
  }
}
