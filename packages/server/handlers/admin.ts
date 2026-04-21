/**
 * Admin RPC handlers -- tenants, teams, users, memberships.
 *
 * Every method in this namespace requires the caller to be an admin.
 * The router materializes `ctx: TenantContext` on every request:
 *
 *   - Local / single-user profile (`requireToken: false`): ctx.isAdmin is
 *     true, so `requireAdmin(ctx)` is a no-op and these handlers behave
 *     identically to the rest of the surface.
 *   - Hosted / control-plane profile (`requireToken: true`): ctx.isAdmin
 *     reflects the bearer token's role. Non-admin tokens (or missing
 *     tokens) resolve to an anonymous context and every method below
 *     throws FORBIDDEN.
 *
 * Namespace contract:
 *   admin/tenant/*   CRUD + status
 *   admin/team/*     CRUD + member management
 *   admin/user/*     CRUD
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { requireAdmin } from "../../core/auth/context.js";
import {
  TenantManager,
  TeamManager,
  UserManager,
  type MembershipRole,
  type TenantStatus,
} from "../../core/auth/index.js";

export function registerAdminHandlers(router: Router, app: AppContext): void {
  const tenants = () => new TenantManager(app.db);
  const teams = () => new TeamManager(app.db);
  const users = () => new UserManager(app.db);

  // ── Tenants ───────────────────────────────────────────────────────────

  router.handle("admin/tenant/list", async (_p, _notify, ctx) => {
    requireAdmin(ctx);
    return { tenants: await tenants().list() };
  });

  router.handle("admin/tenant/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const tenant = await tenants().get(id);
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  router.handle("admin/tenant/create", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { slug, name, status } = extract<{ slug: string; name: string; status?: TenantStatus }>(p, ["slug", "name"]);
    try {
      const tenant = await tenants().create({ slug, name, status });
      return { tenant };
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to create tenant", ErrorCodes.INVALID_PARAMS);
    }
  });

  router.handle("admin/tenant/update", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, slug, name, status } = extract<{
      id: string;
      slug?: string;
      name?: string;
      status?: TenantStatus;
    }>(p, ["id"]);
    const tenant = await tenants().update(id, { slug, name, status });
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  router.handle("admin/tenant/set-status", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, status } = extract<{ id: string; status: TenantStatus }>(p, ["id", "status"]);
    const tenant = await tenants().setStatus(id, status);
    if (!tenant) throw new RpcError(`Tenant '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { tenant };
  });

  router.handle("admin/tenant/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const ok = await tenants().delete(id);
    return { ok };
  });

  // ── Teams ─────────────────────────────────────────────────────────────

  router.handle("admin/team/list", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id } = extract<{ tenant_id: string }>(p, ["tenant_id"]);
    return { teams: await teams().listByTenant(tenant_id) };
  });

  router.handle("admin/team/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const team = await teams().get(id);
    if (!team) throw new RpcError(`Team '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { team };
  });

  router.handle("admin/team/create", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { tenant_id, slug, name, description } = extract<{
      tenant_id: string;
      slug: string;
      name: string;
      description?: string | null;
    }>(p, ["tenant_id", "slug", "name"]);
    const tenant = await tenants().get(tenant_id);
    if (!tenant) throw new RpcError(`Tenant '${tenant_id}' not found`, ErrorCodes.INVALID_PARAMS);
    try {
      const team = await teams().create({ tenant_id, slug, name, description });
      return { team };
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to create team", ErrorCodes.INVALID_PARAMS);
    }
  });

  router.handle("admin/team/update", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id, slug, name, description } = extract<{
      id: string;
      slug?: string;
      name?: string;
      description?: string | null;
    }>(p, ["id"]);
    const team = await teams().update(id, { slug, name, description });
    if (!team) throw new RpcError(`Team '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { team };
  });

  router.handle("admin/team/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const ok = await teams().delete(id);
    return { ok };
  });

  // ── Team members ─────────────────────────────────────────────────────

  router.handle("admin/team/members/list", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id } = extract<{ team_id: string }>(p, ["team_id"]);
    return { members: await teams().listMembers(team_id) };
  });

  router.handle("admin/team/members/add", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id, user_id, email, role } = extract<{
      team_id: string;
      user_id?: string;
      email?: string;
      role?: MembershipRole;
    }>(p, ["team_id"]);

    let resolvedUserId = user_id ?? null;
    if (!resolvedUserId) {
      if (!email) {
        throw new RpcError("admin/team/members/add requires user_id or email", ErrorCodes.INVALID_PARAMS);
      }
      const user = await users().upsertByEmail({ email });
      resolvedUserId = user.id;
    }

    const membership = await teams().addMember(team_id, resolvedUserId, role ?? "member");
    return { membership };
  });

  router.handle("admin/team/members/remove", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id, user_id, email } = extract<{ team_id: string; user_id?: string; email?: string }>(p, ["team_id"]);
    let resolvedUserId = user_id ?? null;
    if (!resolvedUserId && email) {
      const user = await users().get(email);
      if (!user) return { ok: false };
      resolvedUserId = user.id;
    }
    if (!resolvedUserId) {
      throw new RpcError("admin/team/members/remove requires user_id or email", ErrorCodes.INVALID_PARAMS);
    }
    const ok = await teams().removeMember(team_id, resolvedUserId);
    return { ok };
  });

  router.handle("admin/team/members/set-role", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { team_id, user_id, email, role } = extract<{
      team_id: string;
      user_id?: string;
      email?: string;
      role: MembershipRole;
    }>(p, ["team_id", "role"]);
    let resolvedUserId = user_id ?? null;
    if (!resolvedUserId && email) {
      const user = await users().get(email);
      if (!user) throw new RpcError(`User with email '${email}' not found`, ErrorCodes.SESSION_NOT_FOUND);
      resolvedUserId = user.id;
    }
    if (!resolvedUserId) {
      throw new RpcError("admin/team/members/set-role requires user_id or email", ErrorCodes.INVALID_PARAMS);
    }
    const membership = await teams().setRole(team_id, resolvedUserId, role);
    if (!membership) throw new RpcError("Membership not found", ErrorCodes.SESSION_NOT_FOUND);
    return { membership };
  });

  // ── Users ─────────────────────────────────────────────────────────────

  router.handle("admin/user/list", async (_p, _notify, ctx) => {
    requireAdmin(ctx);
    return { users: await users().list() };
  });

  router.handle("admin/user/get", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const user = await users().get(id);
    if (!user) throw new RpcError(`User '${id}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    return { user };
  });

  router.handle("admin/user/create", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { email, name } = extract<{ email: string; name?: string | null }>(p, ["email"]);
    try {
      const user = await users().create({ email, name });
      return { user };
    } catch (e: any) {
      throw new RpcError(e?.message ?? "Failed to create user", ErrorCodes.INVALID_PARAMS);
    }
  });

  router.handle("admin/user/upsert", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { email, name } = extract<{ email: string; name?: string | null }>(p, ["email"]);
    const user = await users().upsertByEmail({ email, name });
    return { user };
  });

  router.handle("admin/user/delete", async (p, _notify, ctx) => {
    requireAdmin(ctx);
    const { id } = extract<{ id: string }>(p, ["id"]);
    const ok = await users().delete(id);
    return { ok };
  });
}
