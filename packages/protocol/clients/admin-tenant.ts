/**
 * AdminTenantClient -- tenant CRUD + tenant Claude auth binding RPCs.
 *
 * Split out of the original monolithic AdminClient so each mixin stays
 * at <= 25 methods. Team / user / policy / api-key / tenant-policy live
 * in `./admin-team.ts`.
 *
 * Carries the tenant-auth half of the agent-F block -- see markers.
 */

import { RpcError } from "../types.js";
import type { RpcFn } from "./rpc.js";

export class AdminTenantClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // ── Admin: tenants ─────────────────────────────────────────────────────────

  async adminTenantList(): Promise<
    Array<{ id: string; slug: string; name: string; status: string; created_at: string; updated_at: string }>
  > {
    const { tenants } = await this.rpc<{ tenants: any[] }>("admin/tenant/list");
    return tenants;
  }

  async adminTenantGet(id: string): Promise<{
    id: string;
    slug: string;
    name: string;
    status: string;
    created_at: string;
    updated_at: string;
  } | null> {
    try {
      const { tenant } = await this.rpc<{ tenant: any }>("admin/tenant/get", { id });
      return tenant;
    } catch (e) {
      if (e instanceof RpcError && e.code === -32002) return null;
      throw e;
    }
  }

  async adminTenantCreate(opts: { slug: string; name: string; status?: string }): Promise<any> {
    const { tenant } = await this.rpc<{ tenant: any }>("admin/tenant/create", opts as Record<string, unknown>);
    return tenant;
  }

  async adminTenantUpdate(opts: { id: string; slug?: string; name?: string; status?: string }): Promise<any> {
    const { tenant } = await this.rpc<{ tenant: any }>("admin/tenant/update", opts as Record<string, unknown>);
    return tenant;
  }

  async adminTenantSetStatus(id: string, status: string): Promise<any> {
    const { tenant } = await this.rpc<{ tenant: any }>("admin/tenant/set-status", { id, status });
    return tenant;
  }

  async adminTenantDelete(id: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/delete", { id });
    return ok;
  }

  // --- BEGIN agent-F: tenant auth binding methods (secret blob half lives in SecretsClient) ---

  /** Get the current Claude auth binding for a tenant (or null if none). */
  async tenantAuthGet(tenantId: string): Promise<{
    tenant_id: string;
    kind: "api_key" | "subscription_blob";
    secret_ref: string;
    created_at: string;
    updated_at: string;
  } | null> {
    const { auth } = await this.rpc<{ auth: any | null }>("admin/tenant/auth/get", { tenant_id: tenantId });
    return auth;
  }

  /**
   * Set the Claude auth binding. `kind: "api_key"` points at a string
   * secret (the value becomes `ANTHROPIC_API_KEY` at dispatch).
   * `kind: "subscription_blob"` points at a blob (materialized into a
   * per-session k8s Secret at `/root/.claude`).
   */
  async tenantAuthSet(tenantId: string, kind: "api_key" | "subscription_blob", secretRef: string): Promise<any> {
    const { auth } = await this.rpc<{ auth: any }>("admin/tenant/auth/set", {
      tenant_id: tenantId,
      kind,
      secret_ref: secretRef,
    });
    return auth;
  }

  /** Clear the Claude auth binding. Idempotent; returns true when a row was removed. */
  async tenantAuthClear(tenantId: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/auth/clear", { tenant_id: tenantId });
    return ok;
  }

  // --- END agent-F ---
}
