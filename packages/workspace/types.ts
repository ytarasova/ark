/**
 * Workspace-package public domain types.
 */

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  created_at: string;
}

export interface Workspace {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  config: Record<string, unknown>;
  created_at: string;
  deleted_at: string | null;
}

export interface Repo {
  id: string;
  tenant_id: string;
  repo_url: string;
  name: string;
  default_branch: string;
  primary_language: string | null;
  local_path: string | null;
  config: Record<string, unknown>;
  created_at: string;
  deleted_at: string | null;
}
