/**
 * code-intel.ts -- RPC surface for the unified code-intel store (Agent D).
 *
 * Wraps `app.codeIntel` (see packages/core/code-intel/store.ts). Every read
 * and write is tenant-scoped: the caller's `TenantContext` provides the
 * tenant SLUG, which we resolve to a tenant id via `getTenantBySlug`. When
 * no slug is available (local / single-user profile) we fall back to the
 * stable `DEFAULT_TENANT_ID`.
 *
 * Namespace:
 *   code-intel/health            -> rolled-up schema + tenant + repo health
 *   code-intel/migration-status  -> schema migrations status
 *   code-intel/migrate           -> apply pending migrations (dev-ish; local mode)
 *   code-intel/reset             -> DROP every code-intel table (DEV ONLY; local mode)
 *   code-intel/tenant/list       -> list tenants (introspection)
 *   code-intel/repo/add          -> register a repo (URL or local path)
 *   code-intel/repo/list         -> list repos for the caller's tenant
 *   code-intel/reindex           -> run the pipeline against a repo
 *   code-intel/search            -> FTS over chunks
 *   code-intel/get-context       -> file/symbol context snapshot
 *
 * Local-by-nature (NOT exposed here, still live in the CLI):
 *   - `ark code-intel doctor` probes the *caller's* VendorResolver + local
 *     `git --version` binary. Both are host-local and make no sense over RPC
 *     to a remote control plane.
 *   - `ark code-intel repo add <path>` with a filesystem path only works
 *     when the daemon shares the caller's filesystem; we still pass the
 *     value through because local daemons + remote daemons that happen to
 *     see the same tree both work. Remote daemons simply record a dead
 *     local_path (the URL-registered variety remains fully portable).
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { DEFAULT_TENANT_ID } from "../../core/code-intel/constants.js";
import { resolveCodeIntelTenantId as resolveTenantId } from "./scope-helpers.js";

export function registerCodeIntelHandlers(router: Router, app: AppContext): void {
  // ── health + migrations ────────────────────────────────────────────────
  router.handle("code-intel/health", async (_p, _notify, _ctx) => {
    const status = await app.codeIntel.migrationStatus();
    const tenants = await app.codeIntel.listTenants();
    const repos = await app.codeIntel.listRepos(DEFAULT_TENANT_ID);
    return {
      schemaVersion: status.currentVersion,
      pending: status.pending.length,
      deploymentMode: app.deployment.mode,
      storeBackend: app.deployment.storeBackend,
      tenantCount: tenants.length,
      defaultTenantRepoCount: repos.length,
      featureCodeIntelV2: app.config.features.codeIntelV2,
    };
  });

  router.handle("code-intel/migration-status", async () => {
    const status = await app.codeIntel.migrationStatus();
    return {
      currentVersion: status.currentVersion,
      pending: status.pending.map((m) => ({ version: m.version, name: m.name })),
    };
  });

  router.handle("code-intel/migrate", async (p) => {
    const { to } = extract<{ to?: number }>(p, []);
    await app.codeIntel.migrate({ targetVersion: typeof to === "number" ? to : undefined });
    const status = await app.codeIntel.migrationStatus();
    return { ok: true, currentVersion: status.currentVersion };
  });

  router.handle("code-intel/reset", async (p) => {
    const { confirm } = extract<{ confirm?: boolean }>(p, []);
    if (confirm !== true) {
      throw new RpcError("refusing to reset without {confirm: true}", ErrorCodes.INVALID_PARAMS);
    }
    await app.codeIntel.reset();
    return { ok: true };
  });

  // ── tenants (read-only introspection) ──────────────────────────────────
  router.handle("code-intel/tenant/list", async () => {
    const tenants = await app.codeIntel.listTenants();
    return { tenants };
  });

  // ── repos ──────────────────────────────────────────────────────────────
  router.handle("code-intel/repo/add", async (p, _notify, ctx) => {
    const { repoUrl, name, defaultBranch, localPath } = extract<{
      repoUrl: string;
      name?: string;
      defaultBranch?: string;
      localPath?: string | null;
    }>(p, ["repoUrl"]);
    if (typeof repoUrl !== "string" || repoUrl.length === 0) {
      throw new RpcError("repoUrl must be a non-empty string", ErrorCodes.INVALID_PARAMS);
    }
    const tenant_id = await resolveTenantId(app, ctx);
    const existing = await app.codeIntel.findRepoByUrl(tenant_id, repoUrl);
    if (existing) {
      return { repo: existing, created: false };
    }
    const derivedName = name ?? (repoUrl.split("/").pop() || "repo");
    const repo = await app.codeIntel.createRepo({
      tenant_id,
      repo_url: repoUrl,
      name: derivedName,
      default_branch: defaultBranch ?? "main",
      local_path: localPath ?? null,
    });
    return { repo, created: true };
  });

  router.handle("code-intel/repo/list", async (_p, _notify, ctx) => {
    const tenant_id = await resolveTenantId(app, ctx);
    const repos = await app.codeIntel.listRepos(tenant_id);
    return { repos };
  });

  // ── reindex ────────────────────────────────────────────────────────────
  router.handle("code-intel/reindex", async (p, _notify, ctx) => {
    const { repoId, extractors } = extract<{ repoId?: string; extractors?: string[] }>(p, []);
    const tenant_id = await resolveTenantId(app, ctx);
    const repos = await app.codeIntel.listRepos(tenant_id);
    if (repos.length === 0) {
      throw new RpcError("no repos registered for this tenant", ErrorCodes.INVALID_PARAMS);
    }
    const target = repoId
      ? repos.find((r) => r.id === repoId || r.id.startsWith(repoId) || r.name === repoId)
      : repos.length === 1
        ? repos[0]
        : null;
    if (!target) {
      throw new RpcError("repo ambiguous or not found; pass repoId", ErrorCodes.INVALID_PARAMS);
    }

    const { CodeIntelPipeline } = await import("../../core/code-intel/pipeline.js");
    const { WAVE1_EXTRACTORS } = await import("../../core/code-intel/extractors/index.js");

    const pipeline = new CodeIntelPipeline({
      store: app.codeIntel,
      vendor: app.deployment.vendorResolver,
      extractors: WAVE1_EXTRACTORS,
    });

    const run =
      Array.isArray(extractors) && extractors.length > 0
        ? await pipeline.runSubset(tenant_id, target.id, extractors)
        : await pipeline.runFullIndex(tenant_id, target.id);

    return {
      run: {
        id: run.id,
        status: run.status,
        tenant_id: run.tenant_id,
        repo_id: run.repo_id,
        branch: run.branch,
        started_at: run.started_at,
        finished_at: run.finished_at ?? null,
        extractor_counts: run.extractor_counts ?? {},
      },
    };
  });

  // ── search ─────────────────────────────────────────────────────────────
  router.handle("code-intel/search", async (p, _notify, ctx) => {
    const { query, limit } = extract<{ query: string; limit?: number }>(p, ["query"]);
    if (typeof query !== "string" || query.length === 0) {
      throw new RpcError("query must be a non-empty string", ErrorCodes.INVALID_PARAMS);
    }
    const tenant_id = await resolveTenantId(app, ctx);
    const { searchQuery } = await import("../../core/code-intel/queries/search.js");
    const hits = await searchQuery.run(
      { tenant_id, store: app.codeIntel },
      { query, limit: typeof limit === "number" ? limit : 20 },
    );
    return { hits };
  });

  // ── get-context ────────────────────────────────────────────────────────
  router.handle("code-intel/get-context", async (p, _notify, ctx) => {
    const { subject, repoId } = extract<{ subject: string; repoId?: string }>(p, ["subject"]);
    if (typeof subject !== "string" || subject.length === 0) {
      throw new RpcError("subject must be a non-empty string", ErrorCodes.INVALID_PARAMS);
    }
    const tenant_id = await resolveTenantId(app, ctx);
    let repo_id: string | undefined;
    if (repoId) {
      const repos = await app.codeIntel.listRepos(tenant_id);
      const match = repos.find((r) => r.id === repoId || r.id.startsWith(repoId) || r.name === repoId);
      repo_id = match?.id;
    }
    const { getContextQuery } = await import("../../core/code-intel/queries/get-context.js");
    const result = await getContextQuery.run({ tenant_id, store: app.codeIntel }, { subject, repo_id });
    return { context: result };
  });
}
