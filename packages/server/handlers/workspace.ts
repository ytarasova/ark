/**
 * workspace.ts -- RPC surface for the workspace layer (Agent D).
 *
 * A workspace groups repos for cross-repo queries and shared platform docs.
 * Backed by `app.codeIntel.*Workspace*`. Every read/write is tenant-scoped:
 * the caller's `TenantContext` slug is resolved to the corresponding
 * tenant uuid via `getTenantBySlug` (falling back to `DEFAULT_TENANT_ID`
 * when no slug is bound, matching the local / single-user profile).
 *
 * Namespace:
 *   workspace/list         -> list workspaces for the caller's tenant
 *   workspace/get          -> fetch one workspace by slug (+ its repos)
 *   workspace/create       -> create a new workspace
 *   workspace/delete       -> soft-delete a workspace (optional force detach)
 *   workspace/status       -> summary (repo count + recent run) for a workspace
 *   workspace/add-repo     -> attach an existing repo to the workspace
 *   workspace/remove-repo  -> detach a repo from the workspace
 *
 * Local-by-nature (NOT exposed here, still uses the in-process AppContext
 * in the CLI):
 *   - `ark workspace use <slug>` writes the active-workspace slug into the
 *     *caller's* ~/.ark/config.yaml. There is no remote filesystem to write
 *     to, so this stays CLI-local.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import type { TenantContext } from "../../core/auth/context.js";
import { DEFAULT_TENANT_ID } from "../../core/code-intel/constants.js";

async function resolveTenantId(app: AppContext, ctx: TenantContext): Promise<string> {
  const slug = ctx.tenantId ?? app.tenantId ?? app.config.authSection.defaultTenant;
  if (slug) {
    const found = await app.codeIntel.getTenantBySlug(slug);
    if (found) return found.id;
  }
  return DEFAULT_TENANT_ID;
}

export function registerWorkspaceHandlers(router: Router, app: AppContext): void {
  router.handle("workspace/list", async (_p, _notify, ctx) => {
    const tenant_id = await resolveTenantId(app, ctx);
    const workspaces = await app.codeIntel.listWorkspaces(tenant_id);
    const enriched = await Promise.all(
      workspaces.map(async (w) => {
        const repos = await app.codeIntel.listReposInWorkspace(tenant_id, w.id);
        return {
          id: w.id,
          slug: w.slug,
          name: w.name,
          description: w.description,
          tenant_id: w.tenant_id,
          created_at: w.created_at,
          repo_count: repos.length,
        };
      }),
    );
    return { workspaces: enriched };
  });

  router.handle("workspace/get", async (p, _notify, ctx) => {
    const { slug } = extract<{ slug: string }>(p, ["slug"]);
    if (typeof slug !== "string" || slug.length === 0) {
      throw new RpcError("slug must be a non-empty string", ErrorCodes.INVALID_PARAMS);
    }
    const tenant_id = await resolveTenantId(app, ctx);
    const ws = await app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
    if (!ws) {
      throw new RpcError(`workspace '${slug}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    const repos = await app.codeIntel.listReposInWorkspace(tenant_id, ws.id);
    return {
      workspace: {
        id: ws.id,
        slug: ws.slug,
        name: ws.name,
        description: ws.description,
        tenant_id: ws.tenant_id,
        created_at: ws.created_at,
        repos,
      },
    };
  });

  router.handle("workspace/create", async (p, _notify, ctx) => {
    const { slug, name, description } = extract<{
      slug: string;
      name?: string;
      description?: string | null;
    }>(p, ["slug"]);
    if (typeof slug !== "string" || slug.length === 0) {
      throw new RpcError("slug must be a non-empty string", ErrorCodes.INVALID_PARAMS);
    }
    const tenant_id = await resolveTenantId(app, ctx);
    const existing = await app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
    if (existing) {
      return { workspace: existing, created: false };
    }
    const derivedName =
      name && name.trim().length > 0 ? name : slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const ws = await app.codeIntel.createWorkspace({
      tenant_id,
      slug,
      name: derivedName,
      description: description ?? null,
    });
    return { workspace: ws, created: true };
  });

  router.handle("workspace/delete", async (p, _notify, ctx) => {
    const { slug, force } = extract<{ slug: string; force?: boolean }>(p, ["slug"]);
    const tenant_id = await resolveTenantId(app, ctx);
    const ws = await app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
    if (!ws) {
      throw new RpcError(`workspace '${slug}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    try {
      await app.codeIntel.softDeleteWorkspace(ws.id, { force: force === true });
    } catch (e: any) {
      throw new RpcError(e?.message ?? "workspace delete failed", ErrorCodes.INVALID_PARAMS);
    }
    return { ok: true };
  });

  router.handle("workspace/status", async (p, _notify, ctx) => {
    const { slug } = extract<{ slug: string }>(p, ["slug"]);
    const tenant_id = await resolveTenantId(app, ctx);
    const ws = await app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
    if (!ws) {
      throw new RpcError(`workspace '${slug}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    const repos = await app.codeIntel.listReposInWorkspace(tenant_id, ws.id);
    return {
      status: {
        id: ws.id,
        slug: ws.slug,
        name: ws.name,
        repo_count: repos.length,
        repos: repos.map((r) => ({ id: r.id, name: r.name, repo_url: r.repo_url })),
      },
    };
  });

  router.handle("workspace/add-repo", async (p, _notify, ctx) => {
    const { slug, repo } = extract<{ slug: string; repo: string }>(p, ["slug", "repo"]);
    const tenant_id = await resolveTenantId(app, ctx);
    const ws = await app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
    if (!ws) {
      throw new RpcError(`workspace '${slug}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    const repos = await app.codeIntel.listRepos(tenant_id);
    const target =
      repos.find((r) => r.id === repo || r.id.startsWith(repo) || r.name === repo || r.repo_url === repo) ?? null;
    if (!target) {
      throw new RpcError(
        `repo '${repo}' not found in this tenant -- register it via code-intel/repo/add first`,
        ErrorCodes.INVALID_PARAMS,
      );
    }
    await app.codeIntel.addRepoToWorkspace(target.id, ws.id);
    return { ok: true, repo_id: target.id, workspace_id: ws.id };
  });

  router.handle("workspace/remove-repo", async (p, _notify, ctx) => {
    const { slug, repo } = extract<{ slug: string; repo: string }>(p, ["slug", "repo"]);
    const tenant_id = await resolveTenantId(app, ctx);
    const ws = await app.codeIntel.getWorkspaceBySlug(tenant_id, slug);
    if (!ws) {
      throw new RpcError(`workspace '${slug}' not found`, ErrorCodes.SESSION_NOT_FOUND);
    }
    const repos = await app.codeIntel.listRepos(tenant_id);
    const target =
      repos.find((r) => r.id === repo || r.id.startsWith(repo) || r.name === repo || r.repo_url === repo) ?? null;
    if (!target) {
      throw new RpcError(`repo '${repo}' not found in tenant`, ErrorCodes.INVALID_PARAMS);
    }
    const current = await app.codeIntel.getRepoWorkspaceId(target.id);
    if (current !== ws.id) {
      return { ok: true, detached: false };
    }
    await app.codeIntel.removeRepoFromWorkspace(target.id);
    return { ok: true, detached: true };
  });
}
