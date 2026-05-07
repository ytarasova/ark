/**
 * Admin RPC handlers for API key management -- the single source of truth.
 *
 *   admin/apikey/list       { tenant_id, include_deleted? }
 *   admin/apikey/create     { tenant_id, name, role?, expires_at? }
 *   admin/apikey/delete     { id, tenant_id? }     -- soft-delete
 *   admin/apikey/restore    { id, tenant_id? }     -- un-soft-delete
 *   admin/apikey/rotate     { id, tenant_id? }     -- revoke + create w/ same meta
 *   admin/apikey/revoke     { id, tenant_id? }     -- alias for /delete (kept for
 *                                                     back-compat with older CLIs)
 *
 * Every method gates on `requireAdmin(ctx)`. The underlying `ApiKeyManager`
 * lives on `AppContext` (`app.apiKeys`) and implements soft-delete semantics:
 * `revoke(id, tenantId, deletedBy)` sets `deleted_at` + `deleted_by` and the
 * validate() path treats a tombstoned row as missing. `restore` reverses both.
 *
 * The `admin/apikey/revoke` method is the pre-soft-delete name for the same
 * operation. We keep it registered so older CLI versions keep working, but
 * new callers should prefer `admin/apikey/delete` -- it's the name that
 * matches every other admin delete verb (`admin/tenant/delete`, etc.).
 *
 * Before this consolidation, `admin/apikey/list` + `admin/apikey/delete` +
 * `admin/apikey/restore` were defined in admin.ts AND `admin/apikey/list` +
 * `admin/apikey/create` + `admin/apikey/revoke` + `admin/apikey/rotate` in
 * this file. register.ts mounted admin.ts first so admin-apikey.ts's list
 * won, silently dropping the `include_deleted` parameter. The Router also
 * allowed the duplicate registration without complaining -- see the new
 * `handle()` duplicate-detection assertion in router.ts.
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
  // ── list ───────────────────────────────────────────────────────────────
  //
  // `include_deleted` is the merged parameter from the old admin.ts variant:
  // passing true returns soft-deleted rows too (useful for the admin UI's
  // "show revoked keys" toggle). Default is false to keep the wire shape
  // backwards-compatible with callers that never set the flag.
  router.handle("admin/apikey/list", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id, include_deleted } = extract<{ tenant_id: string; include_deleted?: boolean }>(p, ["tenant_id"]);
    const keys = await app.apiKeys.list(tenant_id, { includeDeleted: !!include_deleted });
    return { keys: keys.map(projectKey) };
  });

  // ── create ─────────────────────────────────────────────────────────────
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

  // ── delete (soft-delete) ───────────────────────────────────────────────
  //
  // Records `ctx.userId` in `deleted_by` so the audit trail captures who
  // turned the key off. Tenant scoping is delegated to `ApiKeyManager.revoke`
  // -- callers with an explicit tenant_id cannot delete across tenants.
  //
  // `doDelete` matches the Handler shape (params, notify, ctx) so both
  // `admin/apikey/delete` and the back-compat `admin/apikey/revoke` alias
  // can share the body.
  const doDelete: import("../router.js").Handler = async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, tenant_id } = extract<{ id: string; tenant_id?: string }>(p, ["id"]);
    const ok = await app.apiKeys.revoke(id, tenant_id, ctx.userId ?? null);
    return { ok };
  };

  router.handle("admin/apikey/delete", doDelete);
  // Alias for older CLIs. Same semantics -- soft-delete with audit trail.
  router.handle("admin/apikey/revoke", doDelete);

  // ── restore ───────────────────────────────────────────────────────────
  router.handle("admin/apikey/restore", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, tenant_id } = extract<{ id: string; tenant_id?: string }>(p, ["id"]);
    const ok = await app.apiKeys.restore(id, tenant_id);
    return { ok };
  });

  // ── rotate (revoke + create with same meta) ────────────────────────────
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
