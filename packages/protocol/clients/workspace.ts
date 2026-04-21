/**
 * WorkspaceClient -- workspace CRUD + repo attach/detach RPCs.
 *
 * Carries the workspace half of the agent-D block -- see markers.
 */

import type { RpcFn } from "./rpc.js";

export class WorkspaceClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // --- BEGIN agent-D: workspace methods ---

  async workspaceList(): Promise<{
    workspaces: Array<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      tenant_id: string;
      created_at: string;
      repo_count: number;
    }>;
  }> {
    return this.rpc("workspace/list");
  }

  async workspaceGet(slug: string): Promise<{
    workspace: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      tenant_id: string;
      created_at: string;
      repos: any[];
    };
  }> {
    return this.rpc("workspace/get", { slug });
  }

  async workspaceCreate(opts: {
    slug: string;
    name?: string;
    description?: string | null;
  }): Promise<{ workspace: any; created: boolean }> {
    return this.rpc("workspace/create", opts as Record<string, unknown>);
  }

  async workspaceDelete(opts: { slug: string; force?: boolean }): Promise<{ ok: boolean }> {
    return this.rpc("workspace/delete", opts as Record<string, unknown>);
  }

  async workspaceStatus(slug: string): Promise<{
    status: {
      id: string;
      slug: string;
      name: string;
      repo_count: number;
      repos: Array<{ id: string; name: string; repo_url: string }>;
    };
  }> {
    return this.rpc("workspace/status", { slug });
  }

  async workspaceAddRepo(opts: {
    slug: string;
    repo: string;
  }): Promise<{ ok: boolean; repo_id: string; workspace_id: string }> {
    return this.rpc("workspace/add-repo", opts as Record<string, unknown>);
  }

  async workspaceRemoveRepo(opts: { slug: string; repo: string }): Promise<{ ok: boolean; detached: boolean }> {
    return this.rpc("workspace/remove-repo", opts as Record<string, unknown>);
  }

  // --- END agent-D (workspace) ---
}
