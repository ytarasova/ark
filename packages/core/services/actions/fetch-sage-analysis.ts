import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type { ActionHandler } from "./types.js";
import { fetchAnalysis } from "../../integrations/sage-analysis.js";
import { logInfo } from "../../observability/structured-log.js";

/**
 * `fetch_sage_analysis` action -- Stage 1 of the `from-sage-analysis` flow.
 *
 * Reads `inputs.params.analysis_id` (+ optional `inputs.params.sage_base_url`)
 * from the session config, fetches the pi-sage analysis JSON, writes it to
 * `<arkDir>/sage/<sessionId>.analysis.json`, and registers that path under
 * `inputs.files.analysis_json` so the fan-out stage (and any downstream
 * template reference) can read it via `{{inputs.files.analysis_json}}`.
 *
 * Pre-materialised inputs (e.g. an offline sample) flow through transparently:
 * if `inputs.files.analysis_json` is already present, we skip the HTTP fetch
 * and treat the existing file as the source of truth. That's also how the CLI
 * `ark sage <path>` handoff works -- the CLI resolves a local path and passes
 * it as `inputs.files.analysis_json` so no second fetch is needed.
 */
export const fetchSageAnalysisAction: ActionHandler = {
  name: "fetch_sage_analysis",
  async execute(app, session, action) {
    const sessionId = session.id;
    const config = (session.config ?? {}) as Record<string, any>;
    const inputs = (config.inputs ?? {}) as Record<string, any>;
    const params = (inputs.params ?? {}) as Record<string, string>;
    const files = (inputs.files ?? {}) as Record<string, string>;

    // Short-circuit: the CLI entry point supplies the JSON directly.
    if (files.analysis_json) {
      await app.events.log(sessionId, "action_executed", {
        stage: session.stage ?? undefined,
        actor: "system",
        data: { action, skipped: "analysis_json_already_present", path: files.analysis_json },
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

    const sageDir = join(app.config.arkDir, "sage");
    mkdirSync(sageDir, { recursive: true });
    const outPath = join(sageDir, `${sessionId}.analysis.json`);
    writeFileSync(outPath, JSON.stringify(analysis, null, 2), "utf-8");

    // Persist the file path into session inputs so downstream stages pick it up
    // via the standard `{{inputs.files.analysis_json}}` resolution path.
    await app.sessions.mergeConfig(sessionId, {
      inputs: {
        ...inputs,
        files: { ...files, analysis_json: outPath },
      },
    });

    app.events.log(sessionId, "action_executed", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: {
        action,
        analysis_id: analysisId,
        base_url: baseUrl,
        plan_streams: analysis.plan_streams.length,
        affected_repos: analysis.affected_repos?.length ?? 0,
        out_path: outPath,
      },
    });
    return { ok: true, message: `Fetched analysis ${analysisId} (${analysis.plan_streams.length} streams)` };
  },
};
