/**
 * Tenant policy HTTP handlers (hosted control plane only).
 *
 * Local-mode AppContext has no `tenantPolicyManager`; those calls surface
 * as 503s here. Hosted control-plane mounts the manager at DI startup.
 */

import type { AppContext } from "../../app.js";
import { logInfo } from "../../observability/structured-log.js";

export function handleTenantPolicyGet(app: AppContext, tenantId: string): Response {
  try {
    const pm = app.tenantPolicyManager;
    if (!pm)
      return Response.json(
        { error: "Tenant policy manager not available (not running in hosted mode)" },
        { status: 503 },
      );
    const policy = pm.getPolicy(tenantId);
    if (!policy) return Response.json({ error: "policy not found" }, { status: 404 });
    return Response.json(policy);
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export async function handleTenantPolicySet(app: AppContext, req: Request, tenantId: string): Promise<Response> {
  try {
    const pm = app.tenantPolicyManager;
    if (!pm)
      return Response.json(
        { error: "Tenant policy manager not available (not running in hosted mode)" },
        { status: 503 },
      );
    const body = (await req.json()) as Record<string, unknown>;
    pm.setPolicy({
      tenant_id: tenantId,
      allowed_providers: (body.allowed_providers as string[]) ?? [],
      default_provider: (body.default_provider as string) ?? "k8s",
      max_concurrent_sessions: (body.max_concurrent_sessions as number) ?? 10,
      max_cost_per_day_usd: (body.max_cost_per_day_usd as number | null) ?? null,
      compute_pools: (body.compute_pools as unknown as import("../../auth/tenant-policy.js").ComputePoolRef[]) ?? [],
      router_enabled: (body.router_enabled as boolean | null) ?? null,
      router_required: (body.router_required as boolean) ?? false,
      router_policy: (body.router_policy as string | null) ?? null,
      auto_index: (body.auto_index as boolean | null) ?? null,
      auto_index_required: (body.auto_index_required as boolean) ?? false,
      tensorzero_enabled: (body.tensorzero_enabled as boolean | null) ?? null,
      allowed_k8s_contexts: (body.allowed_k8s_contexts as string[]) ?? [],
    });
    logInfo("conductor", `Tenant policy set for: ${tenantId}`);
    return Response.json({ status: "ok", tenant_id: tenantId });
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export function handleTenantPolicyDelete(app: AppContext, tenantId: string): Response {
  try {
    const pm = app.tenantPolicyManager;
    if (!pm)
      return Response.json(
        { error: "Tenant policy manager not available (not running in hosted mode)" },
        { status: 503 },
      );
    const deleted = pm.deletePolicy(tenantId);
    if (!deleted) return Response.json({ error: "policy not found" }, { status: 404 });
    logInfo("conductor", `Tenant policy deleted for: ${tenantId}`);
    return Response.json({ status: "deleted", tenant_id: tenantId });
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}

export function handleTenantPolicyList(app: AppContext): Response {
  try {
    const pm = app.tenantPolicyManager;
    if (!pm)
      return Response.json(
        { error: "Tenant policy manager not available (not running in hosted mode)" },
        { status: 503 },
      );
    return Response.json(pm.listPolicies());
  } catch (e: any) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
