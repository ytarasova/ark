import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../../app-client.js";

/** `ark claude list` -- enumerate Claude Code sessions discovered on disk. */
export function registerClaudeCommands(program: Command): void {
  const claudeCmd = program.command("claude").description("Interact with Claude Code sessions");

  claudeCmd
    .command("list")
    .description("List Claude Code sessions found on disk")
    .option("-p, --project <filter>", "Filter by project path")
    .option("-l, --limit <n>", "Max results", "20")
    .action(async (opts) => {
      const ark = await getArkClient();
      const sessions = await ark.historyList(parseInt(opts.limit));

      if (sessions.length === 0) {
        console.log(chalk.yellow("No Claude sessions found."));
        return;
      }

      console.log(chalk.bold(`Found ${sessions.length} Claude session(s):\n`));
      for (const s of sessions) {
        const date = (s.lastActivity || s.timestamp || "").slice(0, 10);
        const msgs = chalk.dim(`${s.messageCount} msgs`);
        const proj = chalk.cyan(s.project.split("/").slice(-2).join("/"));
        const summary = s.summary ? s.summary.slice(0, 80) : chalk.dim("(no summary)");
        console.log(`  ${chalk.dim(s.sessionId.slice(0, 8))}  ${date}  ${proj}  ${msgs}  ${summary}`);
      }
      console.log(chalk.dim(`\nUse: ark session start --claude-session <id> --flow bare`));
    });
}
