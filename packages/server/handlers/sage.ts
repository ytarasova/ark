/**
 * Sage RPC handlers -- thin wrappers over the `from-sage-analysis` flow.
 *
 * The CLI `ark sage <ref>` currently dispatches a session locally. Moving
 * this to the daemon means fan-out child sessions run on whatever compute
 * the daemon can reach, not just the CLI user's local shell.
 *
 *   - sage/analyze  fetch a pi-sage analysis and dispatch the
 *                   `from-sage-analysis` flow; returns the new session id
 *                   so the CLI can watch it via session/read
 *   - sage/context  dry-run: fetch the analysis and return structured
 *                   metadata (task counts, stream summaries) without
 *                   touching the DB
 *
 * Tenant scoping: dispatch uses `resolveTenantApp(ctx)` so the session is
 * recorded under the caller's tenant. fetchAnalysis itself is tenant-neutral
 * (it's outbound HTTP / local file IO, keyed only on baseUrl + analysisId).
 *
 * Local-by-nature carve-outs (kept on the CLI side, not exposed as RPC):
 *   - Passing a local file path `./foo.analysis.json` as the ref: the CLI
 *     resolves the path against its cwd and passes the resulting absolute
 *     path into `inputs.files.analysis_json`. Over RPC we accept the
 *     analysis payload inline or a `file://` URL the daemon can resolve;
 *     relative-path handling stays CLI-local.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import { fetchAnalysis, type SageAnalysis } from "../../core/integrations/sage-analysis.js";
import { startSession } from "../../core/services/session-lifecycle.js";
import { dispatch } from "../../core/services/dispatch.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const DEFAULT_SAGE_URL = "https://pi-team.mypaytm.com/sage";

function resolveTenantApp(app: AppContext, ctx: { tenantId?: string | null }): AppContext {
  const tenantId = ctx.tenantId ?? app.tenantId ?? app.config.authSection?.defaultTenant ?? null;
  return tenantId ? app.forTenant(tenantId) : app;
}

function countTasks(analysis: SageAnalysis): number {
  return analysis.plan_streams.reduce((n, s) => n + s.tasks.length, 0);
}

export function registerSageHandlers(router: Router, app: AppContext): void {
  router.handle("sage/context", async (p, _notify, _ctx) => {
    const { analysisId, sageUrl } = extract<{ analysisId: string; sageUrl?: string }>(p, ["analysisId"]);
    const baseUrl = sageUrl ?? DEFAULT_SAGE_URL;
    let analysis: SageAnalysis;
    try {
      analysis = await fetchAnalysis(baseUrl, analysisId);
    } catch (e: any) {
      throw new RpcError(`failed to fetch analysis: ${e?.message ?? e}`, ErrorCodes.INVALID_PARAMS);
    }
    return {
      analysisId: analysis.jira_id,
      baseUrl,
      summary: analysis.summary ?? null,
      streamCount: analysis.plan_streams.length,
      taskCount: countTasks(analysis),
      streams: analysis.plan_streams.map((s) => ({
        repo: s.repo,
        branch: s.branch ?? null,
        tasks: s.tasks.map((t) => ({ title: t.title })),
      })),
    };
  });

  router.handle("sage/analyze", async (p, _notify, ctx) => {
    const { analysisId, sageUrl, compute, runtime, repo } = extract<{
      analysisId: string;
      sageUrl?: string;
      compute?: string;
      runtime?: string;
      repo?: string;
    }>(p, ["analysisId"]);
    const baseUrl = sageUrl ?? DEFAULT_SAGE_URL;

    let analysis: SageAnalysis;
    try {
      analysis = await fetchAnalysis(baseUrl, analysisId);
    } catch (e: any) {
      throw new RpcError(`failed to fetch analysis: ${e?.message ?? e}`, ErrorCodes.INVALID_PARAMS);
    }

    const scoped = resolveTenantApp(app, ctx);

    // Materialise analysis JSON on disk so the flow can consume it via
    // inputs.files.analysis_json. Uses the daemon's arkDir (scoped apps
    // inherit config from the root, so this is always the daemon's dir).
    const sageDir = join(scoped.config.arkDir, "sage");
    mkdirSync(sageDir, { recursive: true });
    const analysisPath = join(sageDir, `${analysis.jira_id}.analysis.json`);
    writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), "utf-8");

    const summary = `sage:${analysis.jira_id}`;
    const session = await startSession(scoped, {
      ticket: analysis.jira_id,
      summary,
      repo: repo ?? ".",
      flow: "from-sage-analysis",
      compute_name: compute,
      inputs: {
        files: { analysis_json: analysisPath },
        params: { analysis_id: analysis.jira_id, sage_base_url: baseUrl },
      },
      config: runtime ? { runtime_override: runtime } : undefined,
    });

    const result = await dispatch(scoped, session.id);
    if (!result.ok) {
      return {
        ok: false,
        sessionId: session.id,
        message: result.message ?? "dispatch failed",
        analysisId: analysis.jira_id,
        streamCount: analysis.plan_streams.length,
        taskCount: countTasks(analysis),
      };
    }
    return {
      ok: true,
      sessionId: session.id,
      analysisId: analysis.jira_id,
      streamCount: analysis.plan_streams.length,
      taskCount: countTasks(analysis),
    };
  });
}
