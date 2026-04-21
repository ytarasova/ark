import type { Command } from "commander";
import chalk from "chalk";
import { getArkClient } from "../app-client.js";

export function registerDashboardCommands(program: Command) {
  program
    .command("dashboard")
    .description("Show fleet status, costs, and recent activity")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const ark = await getArkClient();
      const data = await ark.dashboardSummary();

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const { counts, costs, recentEvents, system } = data;

      // Fleet Status
      console.log(chalk.bold("\nFleet Status"));
      const statusLine = [
        counts.running > 0
          ? chalk.green(`\u25CF ${counts.running} running`)
          : chalk.dim(`\u25CF ${counts.running} running`),
        counts.waiting > 0
          ? chalk.yellow(`\u25D1 ${counts.waiting} waiting`)
          : chalk.dim(`\u25D1 ${counts.waiting} waiting`),
        chalk.dim(`\u25CB ${counts.stopped} stopped`),
        counts.failed > 0 ? chalk.red(`\u2715 ${counts.failed} failed`) : chalk.dim(`\u2715 ${counts.failed} failed`),
        chalk.blue(`\u2714 ${counts.completed} completed`),
      ].join("  ");
      console.log(`  ${statusLine}`);
      console.log(chalk.dim(`  ${counts.total} total sessions, ${data.activeCompute} active compute\n`));

      // Costs
      console.log(chalk.bold("Costs"));
      const fmtCost = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
      console.log(
        `  Today: ${chalk.green(fmtCost(costs.today))}  |  Week: ${fmtCost(costs.week)}  |  Month: ${fmtCost(costs.month)}`,
      );

      // Model breakdown
      const models = Object.entries(costs.byModel as Record<string, number>).sort(([, a], [, b]) => b - a);
      if (models.length > 0) {
        const modelParts = models.map(([m, c]) => `${chalk.yellow(m)}: ${fmtCost(c)}`).join("  ");
        console.log(`  ${modelParts}`);
      }

      // Budget
      const budget = costs.budget;
      if (budget?.daily?.limit || budget?.weekly?.limit || budget?.monthly?.limit) {
        const b = budget.daily?.limit ? budget.daily : budget.weekly?.limit ? budget.weekly : budget.monthly;
        if (b?.limit) {
          const pct = Math.min(100, b.pct);
          const filled = Math.round((pct / 100) * 16);
          const barFull = "\u2588".repeat(filled);
          const barEmpty = "\u2591".repeat(16 - filled);
          const barColor = b.exceeded ? chalk.red : b.warning ? chalk.yellow : chalk.green;
          console.log(
            `  Budget: ${fmtCost(b.spent)}/${fmtCost(b.limit)} [${barColor(barFull)}${chalk.dim(barEmpty)}] ${pct.toFixed(1)}%`,
          );
        }
      }
      console.log();

      // Recent Activity
      if (recentEvents.length > 0) {
        console.log(chalk.bold("Recent Activity"));
        for (const ev of recentEvents.slice(0, 8)) {
          const ts = new Date(ev.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const sid = chalk.dim((ev.sessionId ?? "").slice(0, 10));
          const evType = ev.type.replace(/_/g, " ");
          const summary = ev.sessionSummary ? chalk.dim(ev.sessionSummary.slice(0, 40)) : "";
          console.log(`  ${chalk.dim(ts)}  ${sid}  ${evType}  ${summary}`);
        }
        console.log();
      }

      // System
      console.log(chalk.bold("System"));
      const conductor = system.conductor ? chalk.green("\u25CF online") : chalk.red("\u25CF offline");
      const router = system.router ? chalk.green("\u25CF online") : chalk.dim("\u25CB disabled");
      console.log(`  Conductor: ${conductor}`);
      console.log(`  Router:    ${router}`);
      console.log();
    });
}
