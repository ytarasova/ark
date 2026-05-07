/**
 * Tenant resolution for inbound HTTP requests.
 *
 * A thin adapter from `Request` headers to the resolver input shape.
 * Used by the REST mount endpoints on the merged server port.
 */

import type { AppContext } from "../../app.js";

export type TenantResolution = { ok: true; app: AppContext } | { ok: false; response: Response };

/**
 * Resolve the tenant id for an inbound HTTP request by delegating to the
 * mode-specific resolver composed at DI startup. Local and hosted modes
 * have different trust rules (see `app-mode.ts` + the two implementations).
 */
export function resolveTenant(app: AppContext, req: Request) {
  const authHeader = req.headers.get("authorization") ?? req.headers.get("Authorization");
  const tenantHeader = req.headers.get("x-ark-tenant-id") ?? req.headers.get("X-Ark-Tenant-Id");
  return app.mode.tenantResolver.resolve({
    authHeader,
    tenantHeader,
    validateToken: (token) => app.apiKeys.validate(token),
  });
}

/**
 * Resolve the tenant-scoped AppContext for an inbound HTTP request, returning
 * either the scoped app or a ready-to-send error response.
 */
export async function appForRequest(app: AppContext, req: Request): Promise<TenantResolution> {
  const r = await resolveTenant(app, req);
  if (r.ok === false) {
    return { ok: false, response: Response.json({ error: r.error }, { status: r.status }) };
  }
  return { ok: true, app: app.forTenant(r.tenantId) };
}
