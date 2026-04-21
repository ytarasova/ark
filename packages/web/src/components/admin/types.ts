/**
 * Types for the Admin panel (tenants + teams + users).
 * Mirrors the row shapes returned by `admin/*` RPC handlers.
 */

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: "active" | "suspended" | "archived";
  created_at: string;
  updated_at: string;
}

export interface Team {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  updated_at: string;
}

export type MembershipRole = "owner" | "admin" | "member" | "viewer";

export interface Membership {
  id: string;
  user_id: string;
  team_id: string;
  role: MembershipRole;
  created_at: string;
  email: string;
  name: string | null;
}
