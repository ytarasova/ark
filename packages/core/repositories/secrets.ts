/**
 * SecretsRepository -- thin tenant-scoped adapter over `SecretsCapability`.
 *
 * The actual storage lives in `packages/core/secrets/` (file or AWS SSM).
 * This adapter exists so handlers/services can pin a tenant id once and
 * use a familiar repository-style surface, instead of threading the
 * tenant id through every call the way the capability interface demands.
 *
 * New callers that already have a tenant id handy should use
 * `app.secrets.*` directly. Use this adapter when you already have a
 * tenant-scoped AppContext (`app.forTenant(id)`).
 */

import type { SecretRef, SecretsCapability } from "../secrets/types.js";

export class SecretsRepository {
  private _tenantId: string;

  constructor(
    private readonly capability: SecretsCapability,
    tenantId: string,
  ) {
    this._tenantId = tenantId;
  }

  /** Override the bound tenant id. Matches other repos' mutable `setTenant` pattern. */
  setTenant(id: string): void {
    this._tenantId = id;
  }

  tenantId(): string {
    return this._tenantId;
  }

  list(): Promise<SecretRef[]> {
    return this.capability.list(this._tenantId);
  }

  get(name: string): Promise<string | null> {
    return this.capability.get(this._tenantId, name);
  }

  set(name: string, value: string, opts?: { description?: string }): Promise<void> {
    return this.capability.set(this._tenantId, name, value, opts);
  }

  delete(name: string): Promise<boolean> {
    return this.capability.delete(this._tenantId, name);
  }

  resolveMany(names: string[]): Promise<Record<string, string>> {
    return this.capability.resolveMany(this._tenantId, names);
  }
}
