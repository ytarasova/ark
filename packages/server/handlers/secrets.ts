/**
 * Secrets RPC handlers.
 *
 * Surfaces a minimal tenant-scoped CRUD over the `SecretsCapability`
 * installed on the current `AppMode` (file-backed locally, AWS SSM in
 * the control plane).
 *
 * Tenant scoping: the handler reads `app.tenantId` from the tenant-scoped
 * AppContext view set up by the router's auth middleware. When no tenant
 * is bound (local single-user mode), it falls back to
 * `config.authSection.defaultTenant || "default"` -- matching the rest of
 * the surface.
 *
 * What this NEVER does:
 *   - Return values from `secret/list`.
 *   - Log values (we log `secret/get` access, but only the tenant + name).
 *   - Include a value in an error message.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { logInfo } from "../../core/observability/structured-log.js";
import { assertValidSecretName } from "../../core/secrets/types.js";
import type { TenantContext } from "../../core/auth/context.js";

function resolveTenantId(app: AppContext, ctx: TenantContext): string {
  // Caller's ctx wins -- the router already materialized it from the bearer
  // token (hosted) or the default-tenant config (local). Fall through to
  // the legacy `app.tenantId` view + config default to preserve behavior
  // for any caller that still reaches the handler without a ctx.
  return ctx.tenantId ?? app.tenantId ?? app.config.authSection?.defaultTenant ?? "default";
}

function wrapNameError(err: unknown): RpcError {
  const msg = err instanceof Error ? err.message : String(err);
  return new RpcError(msg, ErrorCodes.INVALID_PARAMS);
}

export function registerSecretsHandlers(router: Router, app: AppContext): void {
  router.handle("secret/list", async (_p, _notify, ctx) => {
    const tenantId = resolveTenantId(app, ctx);
    const secrets = await app.secrets.list(tenantId);
    // Defensive: values must never leak over this handler. The capability
    // contract already promises this, but the shape we project here is an
    // explicit refs-only projection.
    const refs = secrets.map((s) => ({
      tenant_id: s.tenant_id,
      name: s.name,
      description: s.description,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));
    return { secrets: refs };
  });

  router.handle("secret/get", async (p, _notify, ctx) => {
    const { name } = extract<{ name: string }>(p, ["name"]);
    try {
      assertValidSecretName(name);
    } catch (err) {
      throw wrapNameError(err);
    }
    const tenantId = resolveTenantId(app, ctx);
    // Intentionally metadata-only in the log (never the value, never an
    // indication of whether the lookup hit or missed).
    logInfo("general", `secret/get tenant=${tenantId} name=${name}`);
    const value = await app.secrets.get(tenantId, name);
    return { value };
  });

  router.handle("secret/set", async (p, _notify, ctx) => {
    const { name, value, description } = extract<{ name: string; value: string; description?: string }>(p, [
      "name",
      "value",
    ]);
    if (typeof value !== "string") {
      throw new RpcError("secret value must be a string", ErrorCodes.INVALID_PARAMS);
    }
    try {
      assertValidSecretName(name);
    } catch (err) {
      throw wrapNameError(err);
    }
    const tenantId = resolveTenantId(app, ctx);
    await app.secrets.set(tenantId, name, value, { description });
    return { ok: true };
  });

  router.handle("secret/delete", async (p, _notify, ctx) => {
    const { name } = extract<{ name: string }>(p, ["name"]);
    try {
      assertValidSecretName(name);
    } catch (err) {
      throw wrapNameError(err);
    }
    const tenantId = resolveTenantId(app, ctx);
    const removed = await app.secrets.delete(tenantId, name);
    return { ok: removed };
  });
}
