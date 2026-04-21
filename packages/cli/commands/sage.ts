import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, isAbsolute, basename } from "path";

import type { AppContext } from "../../core/app.js";
import { fetchAnalysis, type SageAnalysis } from "../../core/integrations/sage-analysis.js";
import { startSession, dispatch } from "../../core/services/session-orchestration.js";

/**
 * `ark sage <analysis-id-or-path>` -- thin wrapper over the
 * `from-sage-analysis` flow. Resolves the analysis reference (HTTP via
 * pi-sage base URL, or a local file path), hands the fetched JSON into the
 * session under `inputs.files.analysis_json`, and dispatches the flow.
 *
 * `--dry-run` prints the dispatch plan (one sub-stream per plan_stream, task
 * counts) without touching the DB or starting agents.
 */
export function registerSageCommands(program: Command, app: AppContext | null): void {
  const requireApp = (): AppContext => {
    if (!app) throw new Error("ark sage requires a local AppContext (not supported in remote mode)");
    return app;
  };

  program
    .command("sage")
    .description("Dispatch the from-sage-analysis flow for a pi-sage analysis")
    .argument("<analysis-id-or-path>", "Jira key (e.g. IN-12345) or path to a local analysis JSON file")
    .option("--sage-url <url>", "Pi-sage base URL", "https://pi-team.mypaytm.com/sage")
    .option("--compute <name>", "Compute target for the parent + child sessions")
    .option("--runtime <name>", "Runtime override (claude, codex, gemini, goose)")
    .option("--repo <path>", "Repo / workdir for the parent session", ".")
    .option("--dry-run", "Print the dispatch plan without creating a session")
    .action(async (ref: string, opts: SageOpts) => {
      const resolvedApp = requireApp();
      const { baseUrl, analysisId, localPath } = resolveAnalysisRef(ref, opts.sageUrl);

      // Fetch analysis first so dry-run can render task counts AND so we fail
      // fast with a clear error before touching the DB.
      let analysis: SageAnalysis;
      try {
        analysis = await fetchAnalysis(baseUrl, analysisId);
      } catch (e: any) {
        console.error(chalk.red(`Failed to fetch analysis: ${e?.message ?? e}`));
        process.exit(1);
      }

      if (opts.dryRun) {
        printDryRun(analysis, { baseUrl, analysisId, localPath });
        return;
      }

      // Persist the analysis into tenant-scoped blob storage so downstream
      // stages (potentially on different replicas in hosted mode) can read
      // it back via `app.blobStore.get(locator, tenantId)`. If the caller
      // pointed us at a local file, load the bytes off disk and upload the
      // same JSON so the contract downstream is uniform (always a locator).
      const bytes = localPath ? readFileSync(localPath) : Buffer.from(JSON.stringify(analysis, null, 2), "utf-8");
      const filename = localPath ? basename(localPath) : `${analysisId}.analysis.json`;
      // Upload under the same tenant the session row will carry -- otherwise
      // the downstream `extractSubtasks` read gets a tenant-mismatch error
      // because locator decoding is scoped. Root AppContext has tenantId=null;
      // `startSession` below uses SessionRepository's "default" fallback, so
      // we match it explicitly here.
      const tenantId = resolvedApp.tenantId ?? "default";
      const meta = await resolvedApp.blobStore.put(
        { tenantId, namespace: "sage-analysis", id: `cli-${analysisId}-${Date.now()}`, filename },
        bytes,
        { contentType: "application/json" },
      );

      const summary = `sage:${analysis.jira_id}`;
      const session = startSession(resolvedApp, {
        ticket: analysis.jira_id,
        summary,
        repo: opts.repo ?? ".",
        workdir: opts.repo ? resolve(opts.repo) : undefined,
        flow: "from-sage-analysis",
        compute_name: opts.compute,
        inputs: {
          files: { analysis_json: meta.locator },
          params: { analysis_id: analysis.jira_id, sage_base_url: baseUrl },
        },
        config: opts.runtime ? { runtime_override: opts.runtime } : undefined,
      });

      console.log(chalk.green(`Created session ${session.id} (flow=from-sage-analysis)`));
      console.log(chalk.dim(`  Analysis: ${analysis.jira_id}`));
      console.log(chalk.dim(`  Streams:  ${analysis.plan_streams.length}`));
      console.log(chalk.dim(`  Tasks:    ${countTasks(analysis)}`));

      const result = await dispatch(resolvedApp, session.id);
      if (!result.ok) {
        console.error(chalk.red(`Dispatch failed: ${result.message}`));
        process.exit(1);
      }
      console.log(chalk.green(`Dispatched. Session id: ${session.id}`));
    });
}

interface SageOpts {
  sageUrl?: string;
  compute?: string;
  runtime?: string;
  repo?: string;
  dryRun?: boolean;
}

interface ResolvedRef {
  baseUrl: string;
  analysisId: string;
  /** When the caller passed a file path, we round-trip that path into the session directly. */
  localPath?: string;
}

/**
 * A sage ref is either:
 *   - a Jira key (IN-12345 etc.) -> fetched from --sage-url
 *   - an absolute path to a JSON file -> read directly
 *   - a relative path starting with ./ or containing /examples/ -> resolved
 *     against cwd
 */
function resolveAnalysisRef(ref: string, sageUrl: string | undefined): ResolvedRef {
  // Path handling first: explicit .json extension or an existing file.
  const looksLikePath = ref.endsWith(".json") || ref.startsWith("./") || ref.startsWith("/") || ref.startsWith("file:");
  if (looksLikePath) {
    const abs = ref.startsWith("file://") ? ref : isAbsolute(ref) ? ref : resolve(ref);
    const fsPath = abs.startsWith("file://") ? abs.slice(7) : abs;
    if (!existsSync(fsPath) || !statSync(fsPath).isFile()) {
      throw new Error(`Analysis file not found: ${fsPath}`);
    }
    const analysisId =
      fsPath
        .split("/")
        .pop()
        ?.replace(/\.analysis\.json$|\.json$/, "") ?? "sage-analysis";
    return {
      baseUrl: `file://${fsPath}`,
      analysisId,
      localPath: fsPath,
    };
  }

  // Jira-key style: fetch from the URL.
  if (!sageUrl) throw new Error("--sage-url is required when passing a Jira key");
  return { baseUrl: sageUrl, analysisId: ref };
}

function countTasks(analysis: SageAnalysis): number {
  return analysis.plan_streams.reduce((n, s) => n + s.tasks.length, 0);
}

function printDryRun(analysis: SageAnalysis, ref: ResolvedRef): void {
  console.log(chalk.bold(`\nfrom-sage-analysis dry-run`));
  console.log(chalk.dim(`  Ticket:    ${analysis.jira_id}`));
  console.log(chalk.dim(`  Base URL:  ${ref.baseUrl}`));
  if (analysis.summary) console.log(chalk.dim(`  Summary:   ${analysis.summary.slice(0, 120)}`));
  console.log(chalk.bold(`\n  Sub-streams (one child session per plan_stream):`));
  for (const [i, stream] of analysis.plan_streams.entries()) {
    console.log(
      `    ${i + 1}. ${stream.repo}${stream.branch ? chalk.dim(`@${stream.branch}`) : ""}  ${chalk.yellow(`${stream.tasks.length} tasks`)}`,
    );
    for (const [j, task] of stream.tasks.entries()) {
      console.log(chalk.dim(`       ${j + 1}. ${task.title}`));
    }
  }
  console.log("");
}
