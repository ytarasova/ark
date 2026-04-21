/**
 * AdminTeamClient -- team + user + tenant-policy + API-key admin RPCs.
 *
 * Split out of the original monolithic AdminClient so each mixin stays
 * at <= 25 methods. Tenant CRUD + tenant auth bindings live in
 * `./admin-tenant.ts`.
 *
 * Carries the agent-B block (tenant policy + api-key) -- see markers.
 */

import { RpcError } from "../types.js";
import type { RpcFn } from "./rpc.js";

export class AdminTeamClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // ── Admin: teams ───────────────────────────────────────────────────────────

  async adminTeamList(tenant_id: string): Promise<any[]> {
    const { teams } = await this.rpc<{ teams: any[] }>("admin/team/list", { tenant_id });
    return teams;
  }

  async adminTeamGet(id: string): Promise<any | null> {
    try {
      const { team } = await this.rpc<{ team: any }>("admin/team/get", { id });
      return team;
    } catch (e) {
      if (e instanceof RpcError && e.code === -32002) return null;
      throw e;
    }
  }

  async adminTeamCreate(opts: {
    tenant_id: string;
    slug: string;
    name: string;
    description?: string | null;
  }): Promise<any> {
    const { team } = await this.rpc<{ team: any }>("admin/team/create", opts as Record<string, unknown>);
    return team;
  }

  async adminTeamUpdate(opts: { id: string; slug?: string; name?: string; description?: string | null }): Promise<any> {
    const { team } = await this.rpc<{ team: any }>("admin/team/update", opts as Record<string, unknown>);
    return team;
  }

  async adminTeamDelete(id: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/team/delete", { id });
    return ok;
  }

  async adminTeamMembersList(team_id: string): Promise<
    Array<{
      id: string;
      user_id: string;
      team_id: string;
      role: "owner" | "admin" | "member" | "viewer";
      created_at: string;
      email: string;
      name?: string | null;
    }>
  > {
    const { members } = await this.rpc<{ members: any[] }>("admin/team/members/list", { team_id });
    return members;
  }

  async adminTeamMembersAdd(opts: {
    team_id: string;
    user_id?: string;
    email?: string;
    role?: "owner" | "admin" | "member" | "viewer";
  }): Promise<any> {
    const { membership } = await this.rpc<{ membership: any }>(
      "admin/team/members/add",
      opts as Record<string, unknown>,
    );
    return membership;
  }

  async adminTeamMembersRemove(opts: { team_id: string; user_id?: string; email?: string }): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/team/members/remove", opts as Record<string, unknown>);
    return ok;
  }

  async adminTeamMembersSetRole(opts: {
    team_id: string;
    user_id?: string;
    email?: string;
    role: "owner" | "admin" | "member" | "viewer";
  }): Promise<any> {
    const { membership } = await this.rpc<{ membership: any }>(
      "admin/team/members/set-role",
      opts as Record<string, unknown>,
    );
    return membership;
  }

  // ── Admin: users ───────────────────────────────────────────────────────────

  async adminUserList(): Promise<
    Array<{ id: string; email: string; name: string | null; created_at: string; updated_at: string }>
  > {
    const { users } = await this.rpc<{ users: any[] }>("admin/user/list");
    return users;
  }

  async adminUserGet(id: string): Promise<any | null> {
    try {
      const { user } = await this.rpc<{ user: any }>("admin/user/get", { id });
      return user;
    } catch (e) {
      if (e instanceof RpcError && e.code === -32002) return null;
      throw e;
    }
  }

  async adminUserCreate(opts: { email: string; name?: string | null }): Promise<any> {
    const { user } = await this.rpc<{ user: any }>("admin/user/create", opts as Record<string, unknown>);
    return user;
  }

  async adminUserUpsert(opts: { email: string; name?: string | null }): Promise<any> {
    const { user } = await this.rpc<{ user: any }>("admin/user/upsert", opts as Record<string, unknown>);
    return user;
  }

  async adminUserDelete(id: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/user/delete", { id });
    return ok;
  }

  // --- BEGIN agent-B: tenant policy + api key methods ---

  async tenantPolicyList(): Promise<
    Array<{
      tenant_id: string;
      allowed_providers: string[];
      default_provider: string;
      max_concurrent_sessions: number;
      max_cost_per_day_usd: number | null;
      compute_pools: Array<{
        pool_name: string;
        provider: string;
        min: number;
        max: number;
        config: Record<string, unknown>;
      }>;
      router_enabled: boolean | null;
      router_required: boolean;
      router_policy: string | null;
      auto_index: boolean | null;
      auto_index_required: boolean;
      tensorzero_enabled: boolean | null;
      allowed_k8s_contexts: string[];
    }>
  > {
    const { policies } = await this.rpc<{ policies: any[] }>("admin/tenant/policy/list");
    return policies;
  }

  async tenantPolicyGet(tenantId: string): Promise<any | null> {
    const { policy } = await this.rpc<{ policy: any | null }>("admin/tenant/policy/get", { tenant_id: tenantId });
    return policy;
  }

  async tenantPolicySet(opts: {
    tenant_id: string;
    allowed_providers?: string[];
    default_provider?: string;
    max_concurrent_sessions?: number;
    max_cost_per_day_usd?: number | null;
    compute_pools?: Array<{
      pool_name: string;
      provider: string;
      min: number;
      max: number;
      config: Record<string, unknown>;
    }>;
    router_enabled?: boolean | null;
    router_required?: boolean;
    router_policy?: string | null;
    auto_index?: boolean | null;
    auto_index_required?: boolean;
    tensorzero_enabled?: boolean | null;
    allowed_k8s_contexts?: string[];
  }): Promise<any> {
    const { policy } = await this.rpc<{ policy: any }>(
      "admin/tenant/policy/set",
      opts as unknown as Record<string, unknown>,
    );
    return policy;
  }

  async tenantPolicyDelete(tenantId: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/tenant/policy/delete", { tenant_id: tenantId });
    return ok;
  }

  async apiKeyList(tenantId: string): Promise<
    Array<{
      id: string;
      tenant_id: string;
      name: string;
      role: "admin" | "member" | "viewer";
      created_at: string;
      last_used_at: string | null;
      expires_at: string | null;
    }>
  > {
    const { keys } = await this.rpc<{ keys: any[] }>("admin/apikey/list", { tenant_id: tenantId });
    return keys;
  }

  async apiKeyCreate(opts: {
    tenant_id: string;
    name: string;
    role?: "admin" | "member" | "viewer";
    expires_at?: string;
  }): Promise<{
    id: string;
    key: string;
    tenant_id: string;
    name: string;
    role: "admin" | "member" | "viewer";
    expires_at: string | null;
  }> {
    return this.rpc("admin/apikey/create", opts as unknown as Record<string, unknown>);
  }

  async apiKeyRevoke(id: string, tenantId?: string): Promise<boolean> {
    const { ok } = await this.rpc<{ ok: boolean }>("admin/apikey/revoke", {
      id,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    });
    return ok;
  }

  async apiKeyRotate(id: string, tenantId?: string): Promise<{ ok: boolean; key: string }> {
    return this.rpc<{ ok: boolean; key: string }>("admin/apikey/rotate", {
      id,
      ...(tenantId ? { tenant_id: tenantId } : {}),
    });
  }

  // --- END agent-B ---
}
