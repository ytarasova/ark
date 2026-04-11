import type { Command } from "commander";
import chalk from "chalk";
import { resolve, join, dirname } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { AppContext } from "../../core/app.js";
import { getArkClient } from "./_shared.js";
import { splitEditorCommand } from "../helpers.js";

export function registerMiscCommands(program: Command, app: AppContext | null) {
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
      const { findSessionByPR } = await import("../../core/integrations/github-pr.js");
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
      const { startIssuePoller } = await import("../../core/integrations/issue-poller.js");
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
    const globalOpts = program.opts();
    const serverUrl = globalOpts.server || process.env.ARK_SERVER;
    const token = globalOpts.token || process.env.ARK_TOKEN;

    // In remote mode, skip local prereq checks (tmux etc. not needed)
    if (!serverUrl) {
      const { checkPrereqs, hasRequiredPrereqs, formatPrereqCheck } = await import("../../core/prereqs.js");
      const prereqs = checkPrereqs();
      if (!hasRequiredPrereqs(prereqs)) {
        console.log(chalk.red("Missing required tools:"));
        console.log(formatPrereqCheck(prereqs));
        process.exit(1);
      }
    }

    // Pass remote config to TUI via env vars (picked up by tui/index.tsx)
    if (serverUrl) process.env.ARK_TUI_SERVER = serverUrl;
    if (token) process.env.ARK_TUI_TOKEN = token;

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
      await import("../../core/conductor/channel.js");
    });

  // ── Auth is registered via commands/auth.ts (API keys + Claude setup) ──────
  // ── Costs is registered via commands/costs.ts ─────────────────────────────

  // ── Exec/Try are registered via commands/exec-try.ts ─────────────────────

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
      const globalOpts = program.opts();
      const remoteUrl = globalOpts.server || process.env.ARK_SERVER;
      const remoteAuthToken = globalOpts.token || process.env.ARK_TOKEN;

      if (remoteUrl) {
        // Proxy mode: forward /api/* to remote control plane
        const { startWebProxy } = await import("../../core/hosted/web-proxy.js");
        const proxy = startWebProxy({
          port: Number(opts.port),
          remoteUrl,
          token: remoteAuthToken,
          readOnly: opts.readOnly,
          apiOnly: opts.apiOnly,
          localToken: opts.token,
        });
        console.log(chalk.green(`Ark web dashboard (proxying to ${remoteUrl}): ${proxy.url}`));
        console.log(chalk.dim("Press Ctrl+C to stop"));
        process.on("SIGINT", () => { proxy.stop(); process.exit(0); });
        await new Promise(() => {});
      } else {
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
      }
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

  // ── Server is registered via commands/server.ts ──────────────────────────

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
