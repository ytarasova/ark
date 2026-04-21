/**
 * TenantClaudeAuthManager -- per-tenant binding between a tenant and the
 * credential material used to authenticate Claude sessions dispatched for
 * that tenant.
 *
 * Two modes:
 *
 *   - `api_key` -- `secret_ref` is the name of a string secret in the
 *     SecretsCapability backend. The value is injected as the
 *     `ANTHROPIC_API_KEY` env var at dispatch time. Works today.
 *
 *   - `subscription_blob` -- `secret_ref` is the name of a blob in the
 *     SecretsCapability backend (set via `secret/blob/set`). At dispatch
 *     the daemon fetches the blob, materializes a per-session k8s Secret,
 *     and wires it into the compute config as `credsSecretName` so
 *     K8sProvider mounts it at `/root/.claude` on the pod.
 *
 * Binding is single-valued: `set(tenantId, kind, ref)` overwrites the
 * previous mode. `clear(tenantId)` drops the binding. Neither operation
 * touches the referenced secret / blob -- admins frequently want to keep
 * those around for re-binding.
 */

import type { IDatabase } from "../database/index.js";
import { logDebug } from "../observability/structured-log.js";
import {
  TenantClaudeAuthRepository,
  type ClaudeAuthKind,
  type TenantClaudeAuthRow,
} from "../repositories/tenant_claude_auth.js";

export type { ClaudeAuthKind, TenantClaudeAuthRow };

const DDL = `CREATE TABLE IF NOT EXISTS tenant_claude_auth (
  tenant_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('api_key','subscription_blob')),
  secret_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export class TenantClaudeAuthManager {
  private _initialized: Promise<void> | null = null;
  private _repo: TenantClaudeAuthRepository;

  constructor(private db: IDatabase) {
    this._repo = new TenantClaudeAuthRepository(db);
  }

  /**
   * Lazily ensure the binding table exists. Tests that boot a raw
   * AppContext already run migrations, but legacy call sites may touch
   * the manager before migrations land; this guard keeps the manager
   * usable on its own.
   */
  private async ensureSchema(): Promise<void> {
    if (this._initialized) return this._initialized;
    this._initialized = (async () => {
      try {
        await this.db.exec(DDL);
      } catch {
        logDebug("general", "tenant_claude_auth exists");
      }
    })();
    return this._initialized;
  }

  async get(tenantId: string): Promise<TenantClaudeAuthRow | null> {
    await this.ensureSchema();
    return this._repo.get(tenantId);
  }

  async set(tenantId: string, kind: ClaudeAuthKind, secretRef: string): Promise<TenantClaudeAuthRow> {
    await this.ensureSchema();
    if (!tenantId || typeof tenantId !== "string") throw new Error("tenantId must be a non-empty string");
    if (kind !== "api_key" && kind !== "subscription_blob") {
      throw new Error(`Invalid claude auth kind '${kind}': must be 'api_key' or 'subscription_blob'`);
    }
    if (!secretRef || typeof secretRef !== "string") throw new Error("secretRef must be a non-empty string");
    return this._repo.set(tenantId, kind, secretRef);
  }

  async clear(tenantId: string): Promise<boolean> {
    await this.ensureSchema();
    return this._repo.delete(tenantId);
  }
}
