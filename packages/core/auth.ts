/**
 * Auth middleware for multi-tenant access control.
 *
 * v1 uses API key-based auth only. JWT/OIDC support can be added later.
 * Keys follow the format: ark_<tenantId>_<random>
 *
 * When auth is disabled (default for local use), all requests get the
 * "default" tenant context with admin role.
 */

import type { TenantContext } from "../types/index.js";
import type { ApiKeyManager } from "./api-keys.js";

export interface AuthConfig {
  enabled: boolean;
  apiKeyEnabled: boolean;
}

/** Default auth config -- auth disabled for backward compat. */
export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  enabled: false,
  apiKeyEnabled: false,
};

/** Default tenant context for unauthenticated / single-tenant mode. */
export const DEFAULT_TENANT_CONTEXT: TenantContext = {
  tenantId: "default",
  userId: "local",
  role: "admin",
};

/**
 * Extract tenant context from an HTTP request.
 *
 * Checks (in order):
 *   1. Authorization: Bearer <token> header (try as API key)
 *   2. ?token=<token> query parameter (backward compat)
 *
 * Returns null if no valid credentials found and auth is enabled.
 * Returns DEFAULT_TENANT_CONTEXT if auth is disabled.
 */
export function extractTenantContext(
  req: Request,
  config: AuthConfig,
  apiKeyManager: ApiKeyManager | null,
): TenantContext | null {
  if (!config.enabled) {
    return DEFAULT_TENANT_CONTEXT;
  }

  // Try Bearer token
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ") && apiKeyManager) {
    const token = auth.slice(7);
    const ctx = apiKeyManager.validate(token);
    if (ctx) return ctx;
  }

  // Try query param (backward compat)
  const url = new URL(req.url);
  const qToken = url.searchParams.get("token");
  if (qToken && apiKeyManager) {
    const ctx = apiKeyManager.validate(qToken);
    if (ctx) return ctx;
  }

  return null;
}

/**
 * Check if a tenant context has sufficient permissions for a write operation.
 * Viewers cannot perform write operations.
 */
export function canWrite(ctx: TenantContext): boolean {
  return ctx.role === "admin" || ctx.role === "member";
}

/**
 * Check if a tenant context has admin permissions.
 */
export function isAdmin(ctx: TenantContext): boolean {
  return ctx.role === "admin";
}
