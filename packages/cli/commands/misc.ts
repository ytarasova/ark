import type { Command } from "commander";
import chalk from "chalk";
import { resolve, join, dirname } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync, execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { AppContext, setApp } from "../../core/app.js";
import { loadConfig } from "../../core/config.js";
import { getArkClient } from "./_shared.js";
import { execSession } from "../exec.js";
import { splitEditorCommand } from "../helpers.js";

export function registerMiscCommands(program: Command, app: AppContext) {
  // ── PR commands ──────────────────────────────────────────────────────────────

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
        const icon = s.status === "running" ? "●" : s.status === "completed" ? "✓" : s.status === "failed" ? "✕" : "○";
        console.log(`  ${icon} ${chalk.dim(s.id)}  ${s.pr_url}  ${s.summary || ""}`);
      }
    });

  pr.command("status")
    .description("Show session bound to a PR URL")
    .argument("<pr-url>", "GitHub PR URL")
    .action(async (prUrl) => {
      const { findSessionByPR } = await import("../../core/github-pr.js");
      const { getApp } = await import("../../core/app.js");
      const session = findSessionByPR(getApp(), prUrl);
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

  // ── Watch (Issue Poller) ─────────────────────────────────────────────────────

  program.command("watch")
    .description("Watch GitHub issues with a label and auto-create sessions")
    .option("-l, --label <label>", "GitHub label to watch", "ark")
    .option("-d, --dispatch", "Auto-dispatch created sessions")
    .option("-i, --interval <ms>", "Poll interval in ms", "60000")
    .action(async (opts) => {
      const { startIssuePoller } = await import("../../core/issue-poller.js");
      const label = opts.label;
      const intervalMs = parseInt(opts.interval, 10);

      console.log(chalk.blue(`Watching issues labeled '${label}' (poll every ${intervalMs / 1000}s)${opts.dispatch ? " -- auto-dispatch on" : ""}`));
      console.log(chalk.dim("Press Ctrl+C to stop.\n"));

      const { getApp } = await import("../../core/app.js");
      const poller = startIssuePoller(getApp(), {
        label,
        intervalMs,
        autoDispatch: opts.dispatch,
      });

      // Keep the process alive until interrupted
      process.on("SIGINT", () => {
        poller.stop();
        console.log(chalk.dim("\nStopped."));
        process.exit(0);
      });

      // Prevent the process from exiting
      await new Promise(() => {});
    });

  // ── Claude session discovery ────────────────────────────────────────────────

  const claudeCmd = program.command("claude").description("Interact with Claude Code sessions");

  claudeCmd.command("list")
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

  // ── Doctor command ──────────────────────────────────────────────────────────

  program.command("doctor")
    .description("Check system prerequisites")
    .action(async () => {
      const { checkPrereqs, formatPrereqCheck, hasRequiredPrereqs } = await import("../../core/prereqs.js");
      const results = checkPrereqs();
      console.log("Ark Prerequisites:");
      console.log(formatPrereqCheck(results));
      if (hasRequiredPrereqs(results)) {
        console.log(chalk.green("\nAll required tools available."));
      } else {
        console.log(chalk.red("\nSome required tools are missing. Install them and try again."));
        process.exit(1);
      }
    });

  // ── TUI command ─────────────────────────────────────────────────────────────

  program.command("tui").description("Launch TUI dashboard").action(async () => {
    const { checkPrereqs, hasRequiredPrereqs, formatPrereqCheck } = await import("../../core/prereqs.js");
    const prereqs = checkPrereqs();
    if (!hasRequiredPrereqs(prereqs)) {
      console.log(chalk.red("Missing required tools:"));
      console.log(formatPrereqCheck(prereqs));
      process.exit(1);
    }

    await import("../../tui/index.js");
  });

  // ── ArkD (universal agent daemon) ────────────────────────────────────────────

  program.command("arkd")
    .description("Start the arkd agent daemon")
    .option("-p, --port <port>", "Port", "19300")
    .option("--hostname <host>", "Bind address (default: 0.0.0.0)", "0.0.0.0")
    .option("--conductor-url <url>", "Conductor URL for channel relay")
    .action(async (opts) => {
      const { startArkd } = await import("../../arkd/index.js");
      const { DEFAULT_CONDUCTOR_URL } = await import("../../core/constants.js");
      const conductorUrl = opts.conductorUrl || DEFAULT_CONDUCTOR_URL;
      startArkd(parseInt(opts.port), { conductorUrl, hostname: opts.hostname });
      // Keep alive
      setInterval(() => {}, 60_000);
    });

  // ── Channel (MCP stdio server for remote compute) ──────────────────────────

  program.command("channel")
    .description("Run the MCP channel server (used by remote agents)")
    .action(async () => {
      await import("../../core/channel.js");
    });

  // ── Auth ────────────────────────────────────────────────────────────────────

  program.command("auth")
    .description("Set up Claude authentication (local + sync to remote hosts)")
    .option("--host <name>", "Run setup-token on a specific remote host instead")
    .action(async (opts) => {
      if (opts.host) {
        const ark = await getArkClient();
        let compute: any;
        try { compute = await ark.computeRead(opts.host); } catch { console.error(`Compute '${opts.host}' not found`); process.exit(1); }
        const cfg = compute.config as { ip?: string };
        if (!cfg.ip) { console.error(`No IP for '${opts.host}'`); process.exit(1); }
        const key = `${process.env.HOME}/.ssh/ark-${compute.name}`;
        console.log(`Running setup-token on ${compute.name} (${cfg.ip})...`);
        execFileSync("ssh", [
          "-i", key, "-o", "StrictHostKeyChecking=no", "-t",
          `ubuntu@${cfg.ip}`, "~/.local/bin/claude setup-token",
        ], { stdio: "inherit" });
      } else {
        const { spawn } = await import("child_process");

        console.log("Setting up Claude authentication...\n");

        // Spawn setup-token as a child process that forwards signals
        const exitCode = await new Promise<number>((resolve) => {
          const child = spawn("claude", ["setup-token"], {
            stdio: "inherit",
          });
          // Forward Ctrl+C to the child
          process.on("SIGINT", () => child.kill("SIGINT"));
          child.on("close", (code) => resolve(code ?? 1));
        });

        if (exitCode !== 0) {
          process.exit(exitCode);
        }

        console.log("\nPaste the full OAuth token (sk-ant-oat01-...) and press Enter:");
        process.stdout.write("> ");
        const readline = await import("readline");
        const rl = readline.createInterface({ input: process.stdin });
        let tokenBuf = "";
        const token = await new Promise<string>((resolve) => {
          rl.on("close", () => resolve(tokenBuf.trim()));
          rl.on("line", (line) => {
            tokenBuf += line.trim();
            if (tokenBuf.startsWith("sk-ant-oat") && tokenBuf.length >= 100) {
              rl.close();
            }
          });
        });

        if (token.startsWith("sk-ant-oat")) {
          const arkDir = join(process.env.HOME!, ".ark");
          mkdirSync(arkDir, { recursive: true });
          writeFileSync(join(arkDir, "claude-oauth-token"), token, { mode: 0o600 });
          console.log(`\n✓ Token saved to ~/.ark/claude-oauth-token`);
          console.log(`  TUI and dispatch will pick it up automatically.`);
        } else if (token) {
          console.log("\nToken doesn't look right (should start with sk-ant-oat). Try again.");
        }
      }
    });

  // ── Costs ──────────────────────────────────────────────────────────────────

  program.command("costs")
    .description("Show cost summary across sessions")
    .option("-n, --limit <n>", "Number of sessions to show", "20")
    .action(async (opts) => {
      const ark = await getArkClient();
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
        const tokens = c.usage ? `${(c.usage.total_tokens / 1000).toFixed(0)}K` : "?";
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
      const data = opts.format === "csv" ? core.exportCostsCsv(sessions) : JSON.stringify(core.getAllSessionCosts(sessions), null, 2);
      if (opts.output) {
        writeFileSync(opts.output, data);
        console.log(chalk.green(`Exported to ${opts.output}`));
      } else {
        console.log(data);
      }
    });

  // ── Exec (headless CI mode) ─────────────────────────────────────────────────

  program.command("exec")
    .description("Run a session non-interactively (for CI/CD)")
    .option("-r, --repo <path>", "Repository path", ".")
    .option("-s, --summary <text>", "Task summary")
    .option("-t, --ticket <key>", "Ticket reference")
    .option("-f, --flow <name>", "Flow name", "bare")
    .option("-c, --compute <name>", "Compute target")
    .option("-g, --group <name>", "Group name")
    .option("-a, --autonomy <level>", "Autonomy: full/execute/edit/read-only")
    .option("-o, --output <format>", "Output: text/json", "text")
    .option("--timeout <seconds>", "Timeout in seconds (0=unlimited)", "0")
    .action(async (opts) => {
      // ark exec needs the conductor running (for hooks)
      // Shut down the CLI app before replacing with exec app
      await app.shutdown();
      const execApp = new AppContext(loadConfig());
      await execApp.boot();
      setApp(execApp);

      const code = await execSession({
        repo: opts.repo,
        summary: opts.summary,
        ticket: opts.ticket,
        flow: opts.flow,
        compute: opts.compute,
        group: opts.group,
        autonomy: opts.autonomy,
        output: opts.output,
        timeout: parseInt(opts.timeout),
      });

      await execApp.shutdown();
      process.exit(code);
    });

  // ── Try (one-shot sandbox) ──────────────────────────────────────────────────

  program.command("try")
    .description("Run a one-shot sandboxed session (auto-cleans up)")
    .argument("<task>")
    .option("--image <image>", "Docker image", "ubuntu:22.04")
    .action(async (task, opts) => {
      const ark = await getArkClient();
      const workdir = process.cwd();
      const session = await ark.sessionStart({
        summary: `[try] ${task}`,
        repo: workdir,
        workdir,
        config: { sandbox: true, sandboxImage: opts.image },
      });
      console.log(chalk.cyan(`Try session: ${session.id}`));
      console.log(chalk.dim("Session will be auto-deleted when done."));

      if (!core.isDockerAvailable()) {
        console.log(chalk.yellow("Warning: Docker not available. Running without sandbox."));
      }

      // Dispatch
      try {
        await ark.sessionDispatch(session.id);
      } catch (e: any) {
        console.log(chalk.red(`Dispatch failed: ${e.message}`));
      }

      // Re-fetch session (dispatch updates session_id in DB)
      const { session: updated } = await ark.sessionRead(session.id);
      if (updated?.session_id) {
        try {
          const cmd = core.attachCommand(updated.session_id);
          execSync(cmd, { stdio: "inherit" });
        } catch { /* detached */ }
      }

      // Auto-cleanup
      await ark.sessionDelete(session.id);
      console.log(chalk.dim("Try session cleaned up."));
    });

  // ── Config ─────────────────────────────────────────────────────────────────

  program.command("config")
    .description("Open Ark config in your editor")
    .option("--path", "Just print the config path")
    .action((opts) => {
      const configPath = join(core.getApp().config.arkDir, "config.yaml");

      // Create default config if missing
      if (!existsSync(configPath)) {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, [
          "# Ark configuration",
          "# See: https://github.com/your-org/ark#configuration",
          "",
          "# hotkeys:",
          "#   delete: x",
          "#   fork: f",
          "",
          "# budgets:",
          "#   dailyLimit: 50",
          "#   weeklyLimit: 200",
          "",
        ].join("\n"));
      }

      if (opts.path) {
        console.log(configPath);
        return;
      }

      const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
      console.log(chalk.dim(`Opening ${configPath} in ${editor}...`));
      const { command: editorCmd, args: editorArgs } = splitEditorCommand(editor);
      execFileSync(editorCmd, [...editorArgs, configPath], { stdio: "inherit" });
    });

  // ── Web dashboard ──────────────────────────────────────────────────────────

  program.command("web")
    .description("Start web dashboard")
    .option("--port <port>", "Listen port", "8420")
    .option("--read-only", "Read-only mode")
    .option("--token <token>", "Bearer token for auth")
    .option("--api-only", "API only, skip static file serving (for dev with Vite)")
    .action(async (opts) => {
      const server = core.startWebServer(core.getApp(), {
        port: Number(opts.port),
        readOnly: opts.readOnly,
        token: opts.token,
        apiOnly: opts.apiOnly,
      });
      console.log(chalk.green(`Ark web dashboard: ${server.url}`));
      console.log(chalk.dim("Press Ctrl+C to stop"));
      process.on("SIGINT", () => { server.stop(); process.exit(0); });
      await new Promise(() => {});
    });

  // ── OpenAPI spec ──────────────────────────────────────────────────────────────

  program.command("openapi")
    .description("Generate OpenAPI spec")
    .action(() => {
      console.log(JSON.stringify(core.generateOpenApiSpec(), null, 2));
    });

  // ── MCP proxy (internal, used by pooled MCP configs) ────────────────────────

  program.command("mcp-proxy")
    .description("Bridge stdin/stdout to a pooled MCP socket (internal)")
    .argument("<socket-path>")
    .action((socketPath) => {
      core.runMcpProxy(socketPath);
    });

  // ── ACP (headless JSON-RPC protocol) ──────────────────────────────────────

  program.command("acp")
    .description("Start headless ACP server on stdin/stdout (JSON-RPC)")
    .action(() => {
      core.runAcpServer(core.getApp());
    });

  // ── Repo map ──────────────────────────────────────────────────────────────

  program.command("repo-map")
    .description("Generate repository structure map")
    .argument("[dir]", "Directory to scan", ".")
    .option("--max-files <n>", "Max files to include", "500")
    .option("--max-depth <n>", "Max directory depth", "10")
    .option("--json", "Output as JSON instead of text")
    .action((dir, opts) => {
      const rootDir = resolve(dir);
      const map = core.generateRepoMap(rootDir, {
        maxFiles: Number(opts.maxFiles),
        maxDepth: Number(opts.maxDepth),
      });

      if (opts.json) {
        console.log(JSON.stringify(map, null, 2));
      } else {
        console.log(chalk.bold(`Repository map: ${rootDir}`));
        console.log(chalk.dim(`${map.totalFiles} files\n`));
        console.log(map.summary);
      }
    });

  // ── Recipe eval ───────────────────────────────────────────────────────────

  program.command("eval")
    .description("Evaluate a recipe by creating N test sessions")
    .argument("<recipe>", "Recipe name")
    .option("-n, --iterations <n>", "Number of iterations", "3")
    .action((recipe, opts) => {
      const result = core.evaluateRecipeSetup(core.getApp(), recipe, Number(opts.iterations));
      if (result.iterations === 0) {
        console.log(chalk.red(`Recipe '${recipe}' not found.`));
        return;
      }
      console.log(chalk.bold(`Evaluation: ${recipe} (${result.iterations} iterations)\n`));
      for (const r of result.results) {
        const icon = r.status === "error" ? chalk.red("x") : chalk.green("ok");
        console.log(`  ${icon} ${r.sessionId || "N/A"} - ${r.status} (${r.durationMs}ms, $${r.cost.toFixed(4)})`);
        if (r.error) console.log(chalk.red(`     ${r.error}`));
      }
      console.log(`\n${chalk.bold("Summary:")}`);
      console.log(`  Success rate: ${(result.summary.successRate * 100).toFixed(0)}%`);
      console.log(`  Avg duration: ${result.summary.avgDurationMs.toFixed(0)}ms`);
      console.log(`  Avg cost:     $${result.summary.avgCost.toFixed(4)}`);
      console.log(`  Total cost:   $${result.summary.totalCost.toFixed(4)}`);
    });

  // ── Server ──────────────────────────────────────────────────────────────────
  const serverCmd = program.command("server").description("JSON-RPC server");

  serverCmd
    .command("start")
    .description("Start the Ark server")
    .option("--stdio", "Use stdio transport (JSONL)")
    .option("--ws", "Use WebSocket transport")
    .option("-p, --port <port>", "WebSocket port", "19400")
    .action(async (opts) => {
      const { AppContext, loadConfig } = await import("../../core/index.js");
      const { ArkServer } = await import("../../server/index.js");
      const { registerAllHandlers } = await import("../../server/register.js");

      const serverApp = new AppContext(loadConfig());
      await serverApp.boot();

      const server = new ArkServer();
      registerAllHandlers(server.router, serverApp);

      if (opts.stdio) {
        server.startStdio();
        process.on("SIGINT", () => { serverApp.shutdown(); process.exit(0); });
        await new Promise(() => {});
      } else {
        const port = parseInt(opts.port);
        const ws = server.startWebSocket(port);
        console.log(`Ark server listening on ws://localhost:${port}`);
        process.on("SIGINT", () => { ws.stop(); serverApp.shutdown(); process.exit(0); });
        await new Promise(() => {});
      }
    });

  // ── Init wizard ───────────────────────────────────────────────────────────

  program.command("init")
    .description("Initialize Ark for this repository")
    .action(async () => {
      const { checkPrereqs, formatPrereqCheck, hasRequiredPrereqs } = await import("../../core/prereqs.js");

      // 1. Check prerequisites
      console.log(chalk.bold("Checking prerequisites..."));
      const prereqs = checkPrereqs();
      console.log(formatPrereqCheck(prereqs));
      if (!hasRequiredPrereqs(prereqs)) {
        console.log(chalk.red("\nInstall missing tools and try again."));
        process.exit(1);
      }
      console.log(chalk.green("\nAll prerequisites OK.\n"));

      // 2. Check Claude auth
      try {
        execFileSync("claude", ["--version"], { stdio: "pipe", timeout: 5000 });
        console.log(chalk.green("+ Claude CLI authenticated"));
      } catch {
        console.log(chalk.yellow("- Claude CLI not found or not authenticated"));
        console.log("  Run: claude auth login");
      }

      // 3. Create .ark.yaml in current dir if not exists
      const arkYamlPath = ".ark.yaml";
      if (!existsSync(arkYamlPath)) {
        writeFileSync(arkYamlPath, [
          "# Ark per-repository configuration",
          "# flow: bare          # Default flow for sessions",
          "# agent: implementer  # Default agent",
          "# verify:             # Verification scripts",
          "#   - npm test",
          "# auto_pr: true       # Auto-create PR on completion",
          "",
        ].join("\n"));
        console.log(chalk.green(`\nCreated ${arkYamlPath} (edit to customize)`));
      } else {
        console.log(chalk.dim(`\n${arkYamlPath} already exists`));
      }

      console.log(chalk.bold("\nReady! Try:"));
      console.log(`  ark session start --repo . --summary "My first task" --dispatch`);
      console.log(`  ark tui`);
    });
}
