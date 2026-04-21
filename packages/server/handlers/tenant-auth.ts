/**
 * Admin RPC handlers for per-tenant Claude auth bindings.
 *
 *   admin/tenant/auth/set    { tenant_id, kind, secret_ref }
 *   admin/tenant/auth/get    { tenant_id }
 *   admin/tenant/auth/clear  { tenant_id }
 *
 * Every method gates on `requireAdmin(ctx)` -- local profile is always
 * admin, hosted profile requires an admin bearer token.
 *
 * The handler body stays narrow: validate inputs, delegate to
 * TenantClaudeAuthManager. The manager persists the binding; dispatch-time
 * code in `packages/core/services/dispatch.ts` consumes it to materialize
 * the right credentials (env var for api_key, per-session k8s Secret for
 * subscription_blob).
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { requireAdmin } from "../../core/auth/context.js";
import { TenantClaudeAuthManager, type ClaudeAuthKind } from "../../core/auth/tenant-claude-auth.js";

export function registerTenantAuthHandlers(router: Router, app: AppContext): void {
  const auth = () => new TenantClaudeAuthManager(app.db);

  router.handle("admin/tenant/auth/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    const row = await auth().get(tenant_id);
    return { auth: row };
  });

  router.handle("admin/tenant/auth/set", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id, kind, secret_ref } = extract<{
      tenant_id: string;
      kind: ClaudeAuthKind;
      secret_ref: string;
    }>(p, ["tenant_id", "kind", "secret_ref"]);
    try {
      const row = await auth().set(tenant_id, kind, secret_ref);
      return { auth: row };
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to set tenant auth", ErrorCodes.INVALID_PARAMS);
    }
  });

  router.handle("admin/tenant/auth/clear", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    const ok = await auth().clear(tenant_id);
    return { ok };
  });
}
