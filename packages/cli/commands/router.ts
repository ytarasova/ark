/**
 * CLI commands for the LLM Router.
 *
 * ark router start [--port 8430] [--policy balanced] [--tensorzero]
 * ark router status
 * ark router costs
 */

import type { Command } from "commander";
import chalk from "chalk";
import { DEFAULT_ROUTER_URL } from "../../core/constants.js";
import { logInfo } from "../../core/observability/structured-log.js";

export function registerRouterCommands(program: Command) {
  const router = program.command("router").description("LLM routing proxy");

  router
    .command("start")
    .description("Start the LLM router server")
    .option("-p, --port <port>", "Listen port", "8430")
    .option("--policy <policy>", "Routing policy: quality, balanced, cost", "balanced")
    .option("--config <path>", "Path to router config YAML")
    .option("--tensorzero", "Enable TensorZero gateway (starts Docker container)")
    .option("--tensorzero-url <url>", "TensorZero URL (skip auto-start, use existing)")
    .option("--tensorzero-port <port>", "TensorZero gateway port", "3000")
    .action(async (opts) => {
      const { loadRouterConfig, startRouter } = await import("../../router/index.js");

      const config = loadRouterConfig({
        port: parseInt(opts.port, 10),
        policy: opts.policy,
      });

      if (config.providers.length === 0) {
        console.log(chalk.red("No providers configured."));
        console.log(chalk.dim("Set at least one API key:"));
        console.log(chalk.dim("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY"));
        console.log(chalk.dim("Or configure providers in ~/.ark/router.yaml"));
        process.exit(1);
      }

      // TensorZero setup
      let tensorZeroUrl: string | undefined = opts.tensorzeroUrl;
      let tzManager: any = null;

      if (opts.tensorzero && !tensorZeroUrl) {
        const { TensorZeroManager } = await import("../../core/router/index.js");
        const tzPort = parseInt(opts.tensorzeroPort, 10);
        tzManager = new TensorZeroManager({
          port: tzPort,
          anthropicKey: process.env.ANTHROPIC_API_KEY,
          openaiKey: process.env.OPENAI_API_KEY,
          geminiKey: process.env.GEMINI_API_KEY,
        });

        console.log(chalk.dim("Starting TensorZero gateway..."));
        try {
          await tzManager.start();
          tensorZeroUrl = tzManager.url;
          console.log(chalk.green(`TensorZero gateway running at ${tensorZeroUrl}`));
        } catch (err) {
          console.log(chalk.red(`Failed to start TensorZero: ${(err as Error).message}`));
          console.log(chalk.dim("Falling back to direct provider dispatch."));
        }
      }

      const server = startRouter(config, { tensorZeroUrl });

      console.log(chalk.green(`LLM Router running at ${server.url}`));
      console.log(chalk.dim(`Policy: ${config.policy}`));
      if (tensorZeroUrl) {
        console.log(chalk.dim(`TensorZero: ${tensorZeroUrl}`));
      }
      console.log(chalk.dim(`Providers: ${config.providers.map((p) => p.name).join(", ")}`));
      console.log(chalk.dim(`Models: ${config.providers.flatMap((p) => p.models).length}`));
      console.log(chalk.dim("\nUsage:"));
      console.log(
        chalk.dim(
          `  curl ${server.url}/v1/chat/completions -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'`,
        ),
      );
      console.log(chalk.dim("\nPress Ctrl+C to stop"));

      process.on("SIGINT", async () => {
        server.stop();
        if (tzManager) {
          console.log(chalk.dim("Stopping TensorZero..."));
          await tzManager.stop();
        }
        console.log(chalk.dim("\nRouter stopped."));
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {});
    });

  router
    .command("status")
    .description("Show router status and stats")
    .option("--url <url>", "Router URL", DEFAULT_ROUTER_URL)
    .option("--tensorzero-url <url>", "TensorZero URL", process.env.ARK_TENSORZERO_URL ?? "http://localhost:3000")
    .action(async (opts) => {
      try {
        const [healthResp, statsResp] = await Promise.all([
          fetch(`${opts.url}/health`),
          fetch(`${opts.url}/v1/router/stats`),
        ]);

        if (!healthResp.ok) {
          console.log(chalk.red("Router is not running or not reachable."));
          process.exit(1);
        }

        const health = (await healthResp.json()) as {
          uptime_ms: number;
          providers?: string[];
          models: number;
        };
        const stats = (await statsResp.json()) as {
          total_requests: number;
          routed_requests: number;
          passthrough_requests: number;
          errors: number;
          fallbacks: number;
          avg_classification_ms?: number;
          avg_routing_ms?: number;
          total_cost_usd?: number;
          requests_by_model?: Record<string, number>;
        };

        console.log(chalk.bold("LLM Router Status\n"));
        console.log(`  Status:     ${chalk.green("running")}`);
        console.log(`  Uptime:     ${formatDuration(health.uptime_ms)}`);
        console.log(`  Providers:  ${(health.providers || []).join(", ")}`);
        console.log(`  Models:     ${health.models}`);

        // TensorZero health check
        let tzHealthy = false;
        try {
          const tzResp = await fetch(`${opts.tensorzeroUrl}/status`);
          tzHealthy = tzResp.ok;
        } catch {
          logInfo("general", "not running");
        }

        console.log(
          `  TensorZero: ${tzHealthy ? chalk.green("running") : chalk.dim("not running")} (${opts.tensorzeroUrl})`,
        );

        console.log();
        console.log(chalk.bold("Stats"));
        console.log(`  Total requests:      ${stats.total_requests}`);
        console.log(`  Routed (auto):       ${stats.routed_requests}`);
        console.log(`  Passthrough:         ${stats.passthrough_requests}`);
        console.log(`  Errors:              ${stats.errors}`);
        console.log(`  Fallbacks:           ${stats.fallbacks}`);
        console.log(`  Avg classification:  ${stats.avg_classification_ms?.toFixed(2)}ms`);
        console.log(`  Avg routing:         ${stats.avg_routing_ms?.toFixed(2)}ms`);
        console.log(`  Total cost:          $${stats.total_cost_usd?.toFixed(4)}`);

        if (Object.keys(stats.requests_by_model || {}).length > 0) {
          console.log();
          console.log(chalk.bold("Requests by Model"));
          for (const [model, count] of Object.entries(stats.requests_by_model)) {
            console.log(`  ${model.padEnd(25)} ${count}`);
          }
        }
      } catch {
        console.log(chalk.red("Could not connect to router. Is it running?"));
        console.log(chalk.dim(`Tried: ${opts.url}`));
        process.exit(1);
      }
    });

  router
    .command("costs")
    .description("Show routing cost breakdown")
    .option("--url <url>", "Router URL", DEFAULT_ROUTER_URL)
    .option("--group-by <field>", "Group by: model, provider, session", "model")
    .action(async (opts) => {
      try {
        const resp = await fetch(`${opts.url}/v1/router/costs?group_by=${opts.groupBy}`);
        if (!resp.ok) {
          console.log(chalk.red("Could not fetch costs. Is the router running?"));
          process.exit(1);
        }

        const costs = (await resp.json()) as Array<{
          key: string;
          request_count: number;
          total_input_tokens: number;
          total_output_tokens: number;
          total_cost_usd: number;
        }>;

        if (!costs || costs.length === 0) {
          console.log(chalk.dim("No cost data yet."));
          return;
        }

        console.log(chalk.bold(`\nCost Breakdown (by ${opts.groupBy})\n`));
        console.log(
          chalk.dim(
            "Name".padEnd(30) + "Requests".padEnd(12) + "Input Tokens".padEnd(16) + "Output Tokens".padEnd(16) + "Cost",
          ),
        );
        console.log(chalk.dim("-".repeat(80)));

        let totalCost = 0;
        for (const c of costs) {
          totalCost += c.total_cost_usd;
          console.log(
            c.key.padEnd(30) +
              String(c.request_count).padEnd(12) +
              formatTokens(c.total_input_tokens).padEnd(16) +
              formatTokens(c.total_output_tokens).padEnd(16) +
              `$${c.total_cost_usd.toFixed(4)}`,
          );
        }

        console.log(chalk.dim("-".repeat(80)));
        console.log(chalk.bold(`${"Total".padEnd(74)}$${totalCost.toFixed(4)}`));
      } catch {
        console.log(chalk.red("Could not connect to router."));
        process.exit(1);
      }
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
