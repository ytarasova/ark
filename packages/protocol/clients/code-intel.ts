/**
 * CodeIntelClient -- code-intel v2 health + repo + search + migration RPCs.
 *
 * Carries part of the agent-D block (code-intel surface) -- see markers.
 * The workspace CRUD half lives in `./workspace.ts`.
 */

import type { RpcFn } from "./rpc.js";

export class CodeIntelClient {
  readonly rpc!: RpcFn;
  constructor(rpc?: RpcFn) {
    if (rpc) this.rpc = rpc;
  }

  // --- BEGIN agent-D: code-intel methods ---

  async codeIntelHealth(): Promise<{
    schemaVersion: number;
    pending: number;
    deploymentMode: string;
    storeBackend: string;
    tenantCount: number;
    defaultTenantRepoCount: number;
    featureCodeIntelV2: boolean;
  }> {
    return this.rpc("code-intel/health");
  }

  async codeIntelMigrationStatus(): Promise<{
    currentVersion: number;
    pending: Array<{ version: number; name: string }>;
  }> {
    return this.rpc("code-intel/migration-status");
  }

  async codeIntelMigrate(opts?: { to?: number }): Promise<{ ok: boolean; currentVersion: number }> {
    return this.rpc("code-intel/migrate", (opts ?? {}) as Record<string, unknown>);
  }

  async codeIntelReset(opts: { confirm: true }): Promise<{ ok: boolean }> {
    return this.rpc("code-intel/reset", opts as Record<string, unknown>);
  }

  async codeIntelTenantList(): Promise<{
    tenants: Array<{ id: string; slug: string; name: string; created_at: string }>;
  }> {
    return this.rpc("code-intel/tenant/list");
  }

  async codeIntelRepoAdd(opts: {
    repoUrl: string;
    name?: string;
    defaultBranch?: string;
    localPath?: string | null;
  }): Promise<{ repo: any; created: boolean }> {
    return this.rpc("code-intel/repo/add", opts as Record<string, unknown>);
  }

  async codeIntelRepoList(): Promise<{
    repos: Array<{
      id: string;
      tenant_id: string;
      repo_url: string;
      name: string;
      default_branch: string;
      primary_language: string | null;
      local_path: string | null;
      config: Record<string, unknown>;
      created_at: string;
    }>;
  }> {
    return this.rpc("code-intel/repo/list");
  }

  async codeIntelReindex(opts?: { repoId?: string; extractors?: string[] }): Promise<{
    run: {
      id: string;
      status: string;
      tenant_id: string;
      repo_id: string;
      branch: string;
      started_at: string;
      finished_at: string | null;
      extractor_counts: Record<string, number>;
    };
  }> {
    return this.rpc("code-intel/reindex", (opts ?? {}) as Record<string, unknown>);
  }

  async codeIntelSearch(
    query: string,
    opts?: { limit?: number },
  ): Promise<{
    hits: Array<{
      chunk_id: string;
      chunk_kind: string;
      content_preview: string;
      [key: string]: unknown;
    }>;
  }> {
    return this.rpc("code-intel/search", { query, ...(opts ?? {}) });
  }

  async codeIntelGetContext(opts: { subject: string; repoId?: string }): Promise<{ context: any }> {
    return this.rpc("code-intel/get-context", opts as Record<string, unknown>);
  }

  // --- END agent-D (code-intel) ---
}
