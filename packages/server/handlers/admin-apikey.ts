/**
 * Admin RPC handlers for API key management.
 *
 *   admin/apikey/create
 *   admin/apikey/list
 *   admin/apikey/revoke
 *   admin/apikey/rotate
 *
 * Every method gates on `requireAdmin(ctx)`. The underlying `ApiKeyManager`
 * is exposed on `AppContext` (`app.apiKeys`); these handlers are a thin
 * transport + audit-friendly wrapper.
 *
 * TODO(agent-A-reconcile): once agent A's soft-delete migration lands on
 * `api_keys`, `admin/apikey/revoke` should call `ApiKeyManager.softDelete`
 * instead of the current hard-delete path (`ApiKeyManager.revoke`). Grep
 * for this marker after both agents land.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { requireAdmin } from "../../core/auth/context.js";
import type { ApiKey } from "../../types/index.js";

type ApiKeyRole = "admin" | "member" | "viewer";

const VALID_ROLES: ApiKeyRole[] = ["admin", "member", "viewer"];

function assertRole(role: string | undefined): ApiKeyRole {
  const r = (role ?? "member") as ApiKeyRole;
  if (!VALID_ROLES.includes(r)) {
    throw new RpcError(`invalid role '${role}': must be one of ${VALID_ROLES.join(", ")}`, ErrorCodes.INVALID_PARAMS);
  }
  return r;
}

function projectKey(k: ApiKey) {
  // Never leak keyHash over the wire.
  return {
    id: k.id,
    tenant_id: k.tenantId,
    name: k.name,
    role: k.role,
    created_at: k.createdAt,
    last_used_at: k.lastUsedAt,
    expires_at: k.expiresAt,
  };
}

export function registerAdminApiKeyHandlers(router: Router, app: AppContext): void {
  router.handle("admin/apikey/list", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    const keys = await app.apiKeys.list(tenant_id);
    return { keys: keys.map(projectKey) };
  });

  router.handle("admin/apikey/create", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id, name, role, expires_at } = extract<{
      tenant_id: string;
      name: string;
      role?: string;
      expires_at?: string;
    }>(p, ["tenant_id", "name"]);
    const r = assertRole(role);
    try {
      const { id, key } = await app.apiKeys.create(tenant_id, name, r, expires_at);
      return { id, key, tenant_id, name, role: r, expires_at: expires_at ?? null };
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to create API key", ErrorCodes.INVALID_PARAMS);
    }
  });

  router.handle("admin/apikey/revoke", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, tenant_id } = extract<{ id: string; tenant_id?: string }>(p, ["id"]);
    // TODO(agent-A-reconcile): swap to soft-delete once the api_keys
    // soft-delete column is in place. For now we fall back to the existing
    // hard-delete so the surface still works pre-migration.
    const ok = await app.apiKeys.revoke(id, tenant_id);
    return { ok };
  });

  router.handle("admin/apikey/rotate", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, tenant_id } = extract<{ id: string; tenant_id?: string }>(p, ["id"]);
    const result = await app.apiKeys.rotate(id, tenant_id);
    if (!result) {
      throw new RpcError(`API key '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    return { ok: true, key: result.key };
  });
}
