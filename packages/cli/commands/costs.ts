import type { Command } from "commander";
import chalk from "chalk";
import { writeFileSync } from "fs";
import * as core from "../../core/index.js";
import { getArkClient } from "./_shared.js";

/**
 * Cost-related CLI commands: `ark costs`, `ark costs-sync`, `ark costs-export`.
 *
 * Extracted from misc.ts to keep that file from being a 600-line catch-all.
 * The three commands together handle:
 *   - the live `costs` UX (per-session list, --by grouped summary, --trend daily chart)
 *   - the `costs-sync` backfill from on-disk transcripts
 *   - the `costs-export` CSV/JSON dump
 */
export function registerCostsCommands(program: Command) {
  program.command("costs")
    .description("Show cost summary across sessions")
    .option("-n, --limit <n>", "Number of rows to show", "20")
    .option("--by <dimension>", "Group by: model, provider, runtime, agent, session, tenant, user")
    .option("--trend", "Show daily cost trend")
    .option("--days <n>", "Days for trend (default 30)")
    .option("--since <date>", "Start date (ISO format)")
    .option("--until <date>", "End date (ISO format)")
    .option("--tenant <id>", "Filter by tenant")
    .action(async (opts) => {
      const ark = await getArkClient();

      // Daily trend mode
      if (opts.trend) {
        const { trend } = await ark.costsTrend({ tenantId: opts.tenant, days: opts.days ? Number(opts.days) : 30 });
        if (trend.length === 0) {
          console.log(chalk.dim("No cost data for the selected period."));
          return;
        }
        console.log(chalk.bold("\nDaily Cost Trend\n"));
        console.log(chalk.dim("Date".padEnd(14) + "Cost"));
        console.log(chalk.dim("\u2500".repeat(30)));
        for (const row of trend) {
          console.log(`${row.date.padEnd(14)}${core.formatCost(row.cost)}`);
        }
        const total = trend.reduce((s, r) => s + r.cost, 0);
        console.log(chalk.dim("\u2500".repeat(30)));
        console.log(chalk.bold(`Total: ${core.formatCost(total)}\n`));
        return;
      }

      // Grouped summary mode
      if (opts.by) {
        const groupBy = opts.by === "agent" ? "agent_role" : opts.by === "session" ? "session_id" : opts.by === "tenant" ? "tenant_id" : opts.by;
        const { summary, total } = await ark.costsSummary({
          groupBy,
          tenantId: opts.tenant,
          since: opts.since,
          until: opts.until,
        });
        if (summary.length === 0) {
          console.log(chalk.dim("No cost data for the selected filters."));
          return;
        }
        console.log(chalk.bold(`\nTotal cost: ${core.formatCost(total)}\n`));
        console.log(chalk.dim(opts.by.padEnd(30) + "Cost".padEnd(12) + "In Tokens".padEnd(14) + "Out Tokens".padEnd(14) + "Records"));
        console.log(chalk.dim("\u2500".repeat(80)));
        const limit = Number(opts.limit);
        for (const row of summary.slice(0, limit)) {
          const key = (row.key ?? "unknown").slice(0, 28).padEnd(30);
          const cost = core.formatCost(row.cost).padEnd(12);
          const inp = `${(row.input_tokens / 1000).toFixed(0)}K`.padEnd(14);
          const out = `${(row.output_tokens / 1000).toFixed(0)}K`.padEnd(14);
          console.log(`${key}${cost}${inp}${out}${row.count}`);
        }
        if (summary.length > limit) {
          console.log(chalk.dim(`\n... and ${summary.length - limit} more rows`));
        }
        return;
      }

      // Default: per-session list
      const { costs, total } = await ark.costsRead();

      if (costs.length === 0) {
        console.log(chalk.dim("No cost data yet. Costs are tracked when sessions complete."));
        return;
      }

      console.log(chalk.bold(`\nTotal cost: ${core.formatCost(total)}\n`));
      console.log(chalk.dim("Session".padEnd(40) + "Model".padEnd(10) + "Cost".padEnd(10) + "Tokens"));
      console.log(chalk.dim("\u2500".repeat(75)));

      const limit = Number(opts.limit);
      for (const c of costs.slice(0, limit)) {
        const name = (c.summary ?? c.sessionId).slice(0, 38).padEnd(40);
        const model = (c.model ?? "?").padEnd(10);
        const cost = core.formatCost(c.cost).padEnd(10);
        const tokens = c.usage ? `${((c.usage.input_tokens + c.usage.output_tokens) / 1000).toFixed(0)}K` : "?";
        console.log(`${name}${model}${cost}${tokens}`);
      }

      if (costs.length > limit) {
        console.log(chalk.dim(`\n... and ${costs.length - limit} more sessions`));
      }
    });

  program.command("costs-sync")
    .description("Backfill cost data from Claude transcripts")
    .action(() => {
      const result = core.syncCosts(core.getApp());
      console.log(chalk.green(`Synced: ${result.synced} sessions, Skipped: ${result.skipped}`));
    });

  program.command("costs-export")
    .description("Export cost data")
    .option("--format <format>", "csv or json", "json")
    .option("-o, --output <file>", "Output file")
    .action(async (opts) => {
      const ark = await getArkClient();
      const sessions = await ark.sessionList({ limit: 500 });
      const app = core.getApp();
      const data = opts.format === "csv" ? core.exportCostsCsv(app, sessions) : JSON.stringify(core.getAllSessionCosts(app, sessions), null, 2);
      if (opts.output) {
        writeFileSync(opts.output, data);
        console.log(chalk.green(`Exported to ${opts.output}`));
      } else {
        console.log(data);
      }
    });
}
