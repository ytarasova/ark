import type { ActionHandler } from "./types.js";
import { fetchAnalysis } from "../../integrations/sage-analysis.js";
import { logInfo } from "../../observability/structured-log.js";

/**
 * `fetch_sage_analysis` action -- Stage 1 of the `from-sage-analysis` flow.
 *
 * Reads `inputs.params.analysis_id` (+ optional `inputs.params.sage_base_url`)
 * from the session config, fetches the pi-sage analysis JSON, uploads it to
 * `app.blobStore` under namespace `sage-analysis`, and stores the opaque
 * blob locator under `inputs.files.analysis_json` so downstream stages
 * (the fan-out + any template reference) can read it via
 * `app.blobStore.get(locator, tenant)`.
 *
 * Pre-materialised inputs (e.g. an offline sample delivered by `ark sage
 * <path>`) flow through transparently: if `inputs.files.analysis_json` is
 * already present, we skip the HTTP fetch and treat the existing value as
 * the source of truth. The CLI's job is to make sure that value is a blob
 * locator -- see `packages/cli/commands/sage.ts`.
 */
export const fetchSageAnalysisAction: ActionHandler = {
  name: "fetch_sage_analysis",
  async execute(app, session, action, _opts) {
    const sessionId = session.id;
    const config = (session.config ?? {}) as Record<string, any>;
    const inputs = (config.inputs ?? {}) as Record<string, any>;
    const params = (inputs.params ?? {}) as Record<string, string>;
    const files = (inputs.files ?? {}) as Record<string, string>;

    // Short-circuit: the CLI entry point supplies the locator directly.
    if (files.analysis_json) {
      await app.events.log(sessionId, "action_executed", {
        stage: session.stage ?? undefined,
        actor: "system",
        data: { action, skipped: "analysis_json_already_present", locator: files.analysis_json },
      });
      return { ok: true, message: `Action '${action}' skipped (analysis JSON already present)` };
    }

    const analysisId = params.analysis_id ?? params.analysisId;
    const baseUrl = params.sage_base_url ?? params.sageBaseUrl ?? "https://pi-team.mypaytm.com/sage";

    if (!analysisId) {
      return {
        ok: false,
        message: "fetch_sage_analysis: missing inputs.params.analysis_id (pass --param analysis_id=<jira-key>)",
      };
    }

    logInfo("session", `[${sessionId}] fetch_sage_analysis: ${baseUrl} -> ${analysisId}`);

    let analysis;
    try {
      analysis = await fetchAnalysis(baseUrl, analysisId);
    } catch (e: any) {
      return { ok: false, message: `fetch_sage_analysis failed: ${e?.message ?? e}` };
    }

    // Upload to tenant-scoped blob storage. Downstream replicas read it via
    // `app.blobStore.get(locator, tenantId)` -- no filesystem coupling.
    // Session.tenant_id is non-null (defaults to "default") -- the locator
    // MUST bake in the same value the readers will resolve to, or
    // `assertTenantMatch` throws and the fan-out stage falls back to its
    // default-subtasks path.
    const bytes = Buffer.from(JSON.stringify(analysis, null, 2), "utf-8");
    const meta = await app.blobStore.put(
      {
        tenantId: session.tenant_id,
        namespace: "sage-analysis",
        id: sessionId,
        filename: `${analysisId}.analysis.json`,
      },
      bytes,
      { contentType: "application/json" },
    );

    await app.sessions.mergeConfig(sessionId, {
      inputs: {
        ...inputs,
        files: { ...files, analysis_json: meta.locator },
      },
    });

    await app.events.log(sessionId, "action_executed", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: {
        action,
        analysis_id: analysisId,
        base_url: baseUrl,
        plan_streams: analysis.plan_streams.length,
        affected_repos: analysis.affected_repos?.length ?? 0,
        locator: meta.locator,
      },
    });
    return { ok: true, message: `Fetched analysis ${analysisId} (${analysis.plan_streams.length} streams)` };
  },
};
