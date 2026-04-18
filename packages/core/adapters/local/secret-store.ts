/**
 * EnvSecretStore adapter -- stub.
 *
 * In Slice 5 this will read from `process.env`, replacing the ad-hoc reads
 * scattered through `app.ts` and `compute/providers/*`.
 */

import type { SecretStore } from "../../ports/secret-store.js";

const NOT_MIGRATED = new Error("EnvSecretStore: not migrated yet -- Slice 5");

export class EnvSecretStore implements SecretStore {
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
