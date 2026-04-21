/**
 * Typed wrappers for the `admin/*` JSON-RPC methods.
 * Kept separate from `useApi.ts` so adding admin RPCs doesn't churn the
 * main api surface.
 */

import { getTransport } from "../../hooks/useApi.js";
import type { Tenant, Team, User, Membership, MembershipRole } from "./types.js";

function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  return getTransport().rpc<T>(method, params);
}

export const adminApi = {
  // Tenants
  listTenants: () => rpc<{ tenants: Tenant[] }>("admin/tenant/list").then((r) => r.tenants),
  createTenant: (body: { slug: string; name: string }) =>
    rpc<{ tenant: Tenant }>("admin/tenant/create", body).then((r) => r.tenant),
  updateTenant: (id: string, patch: Partial<Pick<Tenant, "slug" | "name" | "status">>) =>
    rpc<{ tenant: Tenant }>("admin/tenant/update", { id, ...patch }).then((r) => r.tenant),
  deleteTenant: (id: string) => rpc<{ ok: boolean }>("admin/tenant/delete", { id }).then((r) => r.ok),
  setTenantStatus: (id: string, status: Tenant["status"]) =>
    rpc<{ tenant: Tenant }>("admin/tenant/set-status", { id, status }).then((r) => r.tenant),

  // Teams
  listTeams: (tenantId: string) =>
    rpc<{ teams: Team[] }>("admin/team/list", { tenant_id: tenantId }).then((r) => r.teams),
  createTeam: (body: { tenant_id: string; slug: string; name: string; description?: string | null }) =>
    rpc<{ team: Team }>("admin/team/create", body).then((r) => r.team),
  updateTeam: (id: string, patch: Partial<Pick<Team, "slug" | "name" | "description">>) =>
    rpc<{ team: Team }>("admin/team/update", { id, ...patch }).then((r) => r.team),
  deleteTeam: (id: string) => rpc<{ ok: boolean }>("admin/team/delete", { id }).then((r) => r.ok),

  // Team members
  listMembers: (teamId: string) =>
    rpc<{ members: Membership[] }>("admin/team/members/list", { team_id: teamId }).then((r) => r.members),
  addMember: (teamId: string, email: string, role: MembershipRole) =>
    rpc<{ membership: Membership }>("admin/team/members/add", {
      team_id: teamId,
      email,
      role,
    }).then((r) => r.membership),
  removeMember: (teamId: string, email: string) =>
    rpc<{ ok: boolean }>("admin/team/members/remove", { team_id: teamId, email }).then((r) => r.ok),
  setMemberRole: (teamId: string, email: string, role: MembershipRole) =>
    rpc<{ membership: Membership }>("admin/team/members/set-role", {
      team_id: teamId,
      email,
      role,
    }).then((r) => r.membership),

  // Users
  listUsers: () => rpc<{ users: User[] }>("admin/user/list").then((r) => r.users),
  createUser: (body: { email: string; name?: string | null }) =>
    rpc<{ user: User }>("admin/user/create", body).then((r) => r.user),
  deleteUser: (id: string) => rpc<{ ok: boolean }>("admin/user/delete", { id }).then((r) => r.ok),
};
