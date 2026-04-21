/**
 * RPC handlers for cluster discovery + tenant compute-config CRUD.
 *
 *   cluster/list                             -- any authed caller; returns the
 *                                               effective cluster list for
 *                                               `ctx.tenantId` (system ∪ tenant
 *                                               overlay, tenant wins per-name).
 *   admin/tenant/config/set-compute          -- admin; stores tenant YAML blob.
 *   admin/tenant/config/get-compute          -- admin; returns stored blob (or null).
 *   admin/tenant/config/clear-compute        -- admin; drops the blob.
 *
 * The admin RPCs gate on `requireAdmin(ctx)`. `cluster/list` deliberately
 * does NOT require admin -- a tenant member should be able to see which
 * clusters their sessions could dispatch to (subject to the separate
 * `allowed_k8s_contexts` policy gate at dispatch time).
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { requireAdmin } from "../../core/auth/context.js";
import { TenantPolicyManager } from "../../core/auth/tenant-policy.js";
import { parseClustersYaml, resolveEffectiveClusters } from "../../core/config/clusters.js";

export function registerClusterHandlers(router: Router, app: AppContext): void {
  const policies = () => new TenantPolicyManager(app.db);

  router.handle("cluster/list", async (_p, _notify, ctx) => {
    const tenantId = ctx.tenantId ?? "default";
    const clusters = await resolveEffectiveClusters(app, tenantId);
    // Strip auth blocks from the wire response so a viewer never sees the
    // secret names even indirectly. The name is all that matters for
    // "which cluster am I pointing at?" UX; admin tooling that needs the
    // full shape can read the tenant YAML via the admin/tenant/config/*
    // endpoints below.
    return {
      clusters: clusters.map((c) => ({
        name: c.name,
        kind: c.kind,
        apiEndpoint: c.apiEndpoint,
        defaultNamespace: c.defaultNamespace,
      })),
    };
  });

  router.handle("admin/tenant/config/get-compute", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    const yaml = await policies().getComputeConfig(tenant_id);
    return { yaml };
  });

  router.handle("admin/tenant/config/set-compute", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id, yaml } = extract<{ tenant_id: string; yaml: string }>(p, ["tenant_id", "yaml"]);
    if (typeof yaml !== "string" || yaml.length === 0) {
      throw new RpcError("yaml must be a non-empty string", ErrorCodes.INVALID_PARAMS);
    }
    // Validate shape before persisting so bad YAML fails at set time rather
    // than silently at dispatch.
    try {
      parseClustersYaml(yaml);
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Invalid cluster YAML", ErrorCodes.INVALID_PARAMS);
    }
    await policies().setComputeConfig(tenant_id, yaml);
    return { ok: true };
  });

  router.handle("admin/tenant/config/clear-compute", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    const removed = await policies().clearComputeConfig(tenant_id);
    return { ok: removed };
  });
}
