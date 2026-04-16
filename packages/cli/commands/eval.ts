import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "./_shared.js";

export function registerEvalCommands(program: Command) {
  const evalCmd = program.command("eval").description("Agent performance evaluation");

  evalCmd
    .command("stats")
    .description("Show agent performance stats")
    .option("-a, --agent <role>", "Agent role to filter by")
    .action(async (opts) => {
      const ark = await getArkClient();
      const { stats } = await ark.evalStats(opts.agent);

      if (stats.totalSessions === 0) {
        console.log(chalk.yellow("No eval data found." + (opts.agent ? ` (agent: ${opts.agent})` : "")));
        console.log(chalk.dim("Evals are recorded automatically when sessions complete."));
        return;
      }

      console.log(chalk.bold(`\nAgent Stats${opts.agent ? `: ${opts.agent}` : " (all agents)"}\n`));
      console.log(`  Sessions:        ${stats.totalSessions}`);
      console.log(`  Completion rate: ${(stats.completionRate * 100).toFixed(1)}%`);
      console.log(`  Test pass rate:  ${(stats.testPassRate * 100).toFixed(1)}%`);
      console.log(`  PR rate:         ${(stats.prRate * 100).toFixed(1)}%`);
      console.log(`  Avg turns:       ${stats.avgTurns.toFixed(1)}`);
      console.log(`  Avg duration:    ${formatDuration(stats.avgDurationMs)}`);
      console.log(`  Avg cost:        $${stats.avgCost.toFixed(4)}`);
    });

  evalCmd
    .command("drift")
    .description("Check for performance drift")
    .option("-a, --agent <role>", "Agent role to check")
    .option("-d, --days <n>", "Recent window in days", "7")
    .action(async (opts) => {
      const ark = await getArkClient();
      const { drift } = await ark.evalDrift(opts.agent, Number(opts.days));

      if (!drift.alert && drift.completionRateDelta === 0 && drift.avgCostDelta === 0) {
        console.log(chalk.dim("Not enough data for drift detection (need 3+ evals in each window)."));
        return;
      }

      console.log(chalk.bold(`\nDrift Report${opts.agent ? `: ${opts.agent}` : ""}\n`));

      const completionColor = drift.completionRateDelta >= 0 ? chalk.green : chalk.red;
      const costColor = drift.avgCostDelta <= 0 ? chalk.green : chalk.red;
      const turnsColor = drift.avgTurnsDelta <= 0 ? chalk.green : chalk.red;

      console.log(`  Completion rate: ${completionColor(formatDelta(drift.completionRateDelta * 100, "%"))}`);
      console.log(`  Avg cost:        ${costColor(formatDelta(drift.avgCostDelta * 100, "%"))}`);
      console.log(`  Avg turns:       ${turnsColor(formatDelta(drift.avgTurnsDelta * 100, "%"))}`);

      if (drift.alert) {
        console.log(chalk.red("\n  ALERT: Performance degradation detected!"));
      } else {
        console.log(chalk.green("\n  No significant drift detected."));
      }
    });

  evalCmd
    .command("list")
    .description("List recent eval results")
    .option("-a, --agent <role>", "Agent role to filter by")
    .option("-n, --limit <n>", "Max results", "20")
    .action(async (opts) => {
      const ark = await getArkClient();
      const { evals } = await ark.evalList(opts.agent, Number(opts.limit));

      if (evals.length === 0) {
        console.log(chalk.yellow("No eval results found."));
        return;
      }

      console.log(chalk.bold(`\nRecent Evals (${evals.length})\n`));
      console.log(
        chalk.dim(
          "Session".padEnd(14) +
            "Agent".padEnd(16) +
            "Status".padEnd(12) +
            "Turns".padEnd(8) +
            "Duration".padEnd(12) +
            "Cost",
        ),
      );
      console.log(chalk.dim("-".repeat(72)));

      for (const e of evals) {
        const sid = e.sessionId.slice(0, 12).padEnd(14);
        const agent = (e.agentRole || "?").slice(0, 14).padEnd(16);
        const status = e.metrics.completed ? chalk.green("pass") : chalk.red("fail");
        const turns = String(e.metrics.turnCount).padEnd(8);
        const duration = formatDuration(e.metrics.durationMs).padEnd(12);
        const cost = `$${e.metrics.tokenCost.toFixed(4)}`;
        console.log(`  ${sid}${agent}${status.padEnd(12 + 10)}${turns}${duration}${cost}`);
      }
    });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatDelta(value: number, suffix: string): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}${suffix}`;
}
