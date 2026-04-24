import type { Command } from "commander";
import chalk from "chalk";
import * as core from "../../../core/index.js";
import { getArkClient, getInProcessApp } from "../../app-client.js";
import { statusIcon } from "../../formatters.js";

/**
 * `pr` subcommands -- list sessions bound to GitHub PRs and look up the
 * session for a given PR URL.
 */
export function registerPrCommands(program: Command): void {
  const pr = program.command("pr").description("Manage PR-bound sessions");

  pr.command("list")
    .description("List sessions bound to PRs")
    .action(async () => {
      const ark = await getArkClient();
      const sessions = await ark.sessionList({ limit: 50, groupPrefix: core.profileGroupPrefix() || undefined });
      const prSessions = sessions.filter((s: any) => s.pr_url);
      if (prSessions.length === 0) {
        console.log(chalk.yellow("No PR-bound sessions."));
        return;
      }
      for (const s of prSessions) {
        console.log(`  ${statusIcon(s.status)} ${chalk.dim(s.id)}  ${s.pr_url}  ${s.summary || ""}`);
      }
    });

  pr.command("status")
    .description("Show session bound to a PR URL")
    .argument("<pr-url>", "GitHub PR URL")
    .action(async (prUrl) => {
      const app = await getInProcessApp();
      const { findSessionByPR } = await import("../../../core/integrations/github-pr.js");
      const session = await findSessionByPR(app, prUrl);
      if (!session) {
        console.log(chalk.yellow(`No session for ${prUrl}`));
        return;
      }
      console.log(`  Session: ${session.id}`);
      console.log(`  Status:  ${session.status}`);
      console.log(`  Flow:    ${session.flow}`);
      console.log(`  Stage:   ${session.stage || "-"}`);
      console.log(`  Summary: ${session.summary || "-"}`);
    });
}
