/**
 * Workspace + Repo domain types -- standalone now that code-intel is gone.
 *
 * A workspace is a tenant-scoped bundle of repos. The session dispatcher
 * uses workspaces to materialise multi-repo workdirs (one per session)
 * via `provisionWorkspaceWorkdir`.
 *
 * Repos belong to a tenant and may optionally be attached to a workspace
 * (via `repos.workspace_id`). Soft-delete is respected on all reads.
 */

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
