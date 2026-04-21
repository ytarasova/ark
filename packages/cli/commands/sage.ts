import type { Command } from "commander";
import chalk from "chalk";
import { existsSync, statSync } from "fs";
import { resolve, isAbsolute } from "path";

import { getArkClient } from "../app-client.js";

/**
 * `ark sage <analysis-id-or-path>` -- thin client over the daemon's
 * `sage/analyze` and `sage/context` RPCs.
 *
 * The daemon owns the session + flow dispatch for `from-sage-analysis`.
 * When the caller passes a Jira key, we forward it straight through. When
 * they pass a file path, we forward it as a `file://` URL so the daemon
 * can read it directly.
 *
 * Local-by-nature carve-outs:
 *   - Relative paths (`./foo.json`): the CLI resolves them against its own
 *     cwd before handing the daemon an absolute `file://` URL. The daemon
 *     has no cwd relative to the user, so this path handling is CLI-side.
 *   - Existence checks on the local file happen CLI-side so the error
 *     message names the correct path from the user's perspective.
 */
export function registerSageCommands(program: Command): void {
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
      const ark = await getArkClient();
      const { sageUrl, analysisId } = resolveAnalysisRef(ref, opts.sageUrl);

      if (opts.dryRun) {
        try {
          const ctx = await ark.sageContext({ analysisId, sageUrl });
          console.log(chalk.bold(`\nfrom-sage-analysis dry-run`));
          console.log(chalk.dim(`  Ticket:    ${ctx.analysisId}`));
          console.log(chalk.dim(`  Base URL:  ${ctx.baseUrl}`));
          if (ctx.summary) console.log(chalk.dim(`  Summary:   ${ctx.summary.slice(0, 120)}`));
          console.log(chalk.bold(`\n  Sub-streams (one child session per plan_stream):`));
          for (const [i, stream] of ctx.streams.entries()) {
            console.log(
              `    ${i + 1}. ${stream.repo}${stream.branch ? chalk.dim(`@${stream.branch}`) : ""}  ${chalk.yellow(`${stream.tasks.length} tasks`)}`,
            );
            for (const [j, task] of stream.tasks.entries()) {
              console.log(chalk.dim(`       ${j + 1}. ${task.title}`));
            }
          }
          console.log("");
        } catch (e: any) {
          console.error(chalk.red(`Failed to fetch analysis: ${e?.message ?? e}`));
          process.exit(1);
        }
        return;
      }

      try {
        const result = await ark.sageAnalyze({
          analysisId,
          sageUrl,
          compute: opts.compute,
          runtime: opts.runtime,
          repo: opts.repo,
        });
        if (!result.ok) {
          console.error(chalk.red(`Dispatch failed: ${result.message ?? "unknown error"}`));
          if (result.sessionId) console.error(chalk.dim(`  Session id: ${result.sessionId}`));
          process.exit(1);
        }
        console.log(chalk.green(`Created session ${result.sessionId} (flow=from-sage-analysis)`));
        console.log(chalk.dim(`  Analysis: ${result.analysisId}`));
        console.log(chalk.dim(`  Streams:  ${result.streamCount}`));
        console.log(chalk.dim(`  Tasks:    ${result.taskCount}`));
        console.log(chalk.green(`Dispatched. Session id: ${result.sessionId}`));
      } catch (e: any) {
        console.error(chalk.red(`Failed: ${e?.message ?? e}`));
        process.exit(1);
      }
      // NOTE: origin/main had a BlobStore-backed direct-dispatch variant here
      // (uploaded the analysis JSON into tenant-scoped blob storage then called
      // `startSession` + `dispatch` directly). We moved to CLI-daemon-first
      // ("CLI only talks to the control plane"), so the BlobStore upload needs
      // to move server-side into the `sage/analyze` handler. Tracked for
      // follow-up: re-apply the BlobStore persistence inside the handler so
      // downstream stages on other replicas can read the analysis JSON.
    });
}

interface SageOpts {
  sageUrl?: string;
  compute?: string;
  runtime?: string;
  repo?: string;
  dryRun?: boolean;
}

/**
 * A sage ref is either:
 *   - a Jira key (IN-12345 etc.) -> fetched over HTTP from --sage-url
 *   - a file path -> converted into a `file://` URL the daemon can read
 */
function resolveAnalysisRef(ref: string, sageUrl: string | undefined): { sageUrl: string; analysisId: string } {
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
    return { sageUrl: `file://${fsPath}`, analysisId };
  }

  if (!sageUrl) throw new Error("--sage-url is required when passing a Jira key");
  return { sageUrl, analysisId: ref };
}
