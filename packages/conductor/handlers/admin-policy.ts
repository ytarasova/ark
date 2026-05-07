/**
 * Admin RPC handlers for tenant compute policies.
 *
 *   admin/tenant/policy/set
 *   admin/tenant/policy/get
 *   admin/tenant/policy/list
 *   admin/tenant/policy/delete
 *
 * Every method gates on `requireAdmin(ctx)` -- in hosted / control-plane mode
 * non-admin bearer tokens (or the anonymous fallback) throw FORBIDDEN; in
 * local / single-user mode the default context is local-admin so the gate is
 * a no-op.
 *
 * Payload shape mirrors `TenantComputePolicy` from
 * `packages/core/auth/tenant-policy.ts`. The `set` handler accepts partial
 * updates and fills in defaults for every optional field so CLI / web
 * callers do not have to re-send every column on every update.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { requireAdmin } from "../../core/auth/context.js";
import type { ComputePoolRef, TenantComputePolicy, TenantPolicyManager } from "../../core/auth/index.js";

export function registerAdminPolicyHandlers(router: Router, app: AppContext): void {
  // TenantPolicyManager is registered as a DI singleton; `app.tenantPolicyManager`
  // is non-null in both local + hosted modes. The accessor still typed as
  // `TenantPolicyManager | null` for historical reasons -- assert here so the
  // handler bodies don't all need to null-check it.
  const policies = (): TenantPolicyManager => {
    const pm = app.tenantPolicyManager;
    if (!pm) throw new RpcError("TenantPolicyManager not available", ErrorCodes.INTERNAL_ERROR);
    return pm;
  };

  router.handle("admin/tenant/policy/list", async (_p, _notify, ctx) => {
    requireAdmin(ctx);
    return { policies: await policies().listPolicies() };
  });

  router.handle("admin/tenant/policy/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    const policy = await policies().getPolicy(tenant_id);
    return { policy };
  });

  router.handle("admin/tenant/policy/set", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const params = extract<{
      tenant_id: string;
      allowed_providers?: string[];
      default_provider?: string;
      max_concurrent_sessions?: number;
      max_cost_per_day_usd?: number | null;
      compute_pools?: ComputePoolRef[];
      router_enabled?: boolean | null;
      router_required?: boolean;
      router_policy?: string | null;
      auto_index?: boolean | null;
      auto_index_required?: boolean;
      tensorzero_enabled?: boolean | null;
      allowed_k8s_contexts?: string[];
    }>(p, ["tenant_id"]);

    const pm = policies();
    const existing = await pm.getPolicy(params.tenant_id);
    const next: TenantComputePolicy = {
      tenant_id: params.tenant_id,
      allowed_providers: params.allowed_providers ?? existing?.allowed_providers ?? [],
      default_provider: params.default_provider ?? existing?.default_provider ?? "k8s",
      max_concurrent_sessions: params.max_concurrent_sessions ?? existing?.max_concurrent_sessions ?? 10,
      max_cost_per_day_usd:
        params.max_cost_per_day_usd !== undefined
          ? params.max_cost_per_day_usd
          : (existing?.max_cost_per_day_usd ?? null),
      compute_pools: params.compute_pools ?? existing?.compute_pools ?? [],
      router_enabled: params.router_enabled !== undefined ? params.router_enabled : (existing?.router_enabled ?? null),
      router_required: params.router_required ?? existing?.router_required ?? false,
      router_policy: params.router_policy !== undefined ? params.router_policy : (existing?.router_policy ?? null),
      auto_index: params.auto_index !== undefined ? params.auto_index : (existing?.auto_index ?? null),
      auto_index_required: params.auto_index_required ?? existing?.auto_index_required ?? false,
      tensorzero_enabled:
        params.tensorzero_enabled !== undefined ? params.tensorzero_enabled : (existing?.tensorzero_enabled ?? null),
      allowed_k8s_contexts: params.allowed_k8s_contexts ?? existing?.allowed_k8s_contexts ?? [],
    };

    try {
      await pm.setPolicy(next);
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to set tenant policy", ErrorCodes.INVALID_PARAMS);
    }

    const saved = await pm.getPolicy(params.tenant_id);
    return { policy: saved };
  });

  router.handle("admin/tenant/policy/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    const ok = await policies().deletePolicy(tenant_id);
    return { ok };
  });
}
