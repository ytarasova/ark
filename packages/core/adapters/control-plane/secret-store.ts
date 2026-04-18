/**
 * VaultSecretStore adapter -- stub.
 *
 * Loads secrets from HashiCorp Vault / equivalent; replaces direct
 * `process.env` reads in the hosted deployment. Slice 5.
 */

import type { SecretStore } from "../../ports/secret-store.js";

const NOT_MIGRATED = new Error("VaultSecretStore: not migrated yet -- Slice 5");

export class VaultSecretStore implements SecretStore {
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
