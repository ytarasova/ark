import type { Command } from "commander";
import chalk from "chalk";
import { join } from "path";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { homedir } from "os";
import { getArkClient } from "../app-client.js";
import { logDebug } from "../../core/observability/structured-log.js";

/**
 * `ark conductor` -- conductor RPC operations plus arkd lifecycle management.
 *
 * Lifecycle subcommands (start/stop/status) manage the arkd agent daemon
 * (port 19300) with PID file tracking. These were previously under
 * `ark daemon`; that command has been retired.
 *
 * RPC subcommands (learnings, learn, bridge, notify, status) ride
 * `getArkClient()` so `--server <url>` works the same as talking to a
 * local auto-spawned daemon.
 *
 * Local-by-nature carve-outs:
 *   - The `bridge` subcommand calls the RPC (which arms the poller on the
 *     daemon) and returns immediately; the poller outlives this CLI
 *     invocation on the daemon side.
 */

// ── PID file helpers ──────────────────────────────────────────────────────────

function pidFilePath(arkDir?: string): string {
  return join(arkDir ?? join(homedir(), ".ark"), "daemon.pid");
}

interface DaemonPidInfo {
  pid: number;
  port: number;
  hostname: string;
  startedAt: string;
}

function readPidFile(arkDir?: string): DaemonPidInfo | null {
  const pidPath = pidFilePath(arkDir);
  if (!existsSync(pidPath)) return null;
  try {
    return JSON.parse(readFileSync(pidPath, "utf-8")) as DaemonPidInfo;
  } catch {
    return null;
  }
}

function writePidFile(info: DaemonPidInfo, arkDir?: string): void {
  const pidPath = pidFilePath(arkDir);
  mkdirSync(join(pidPath, ".."), { recursive: true });
  writeFileSync(pidPath, JSON.stringify(info));
}

function removePidFile(arkDir?: string): void {
  const pidPath = pidFilePath(arkDir);
  try {
    unlinkSync(pidPath);
  } catch {
    logDebug("general", "already gone");
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerConductorCommands(program: Command) {
  const conductorCmd = program.command("conductor").description("Conductor operations and arkd lifecycle");

  // ── conductor start ───────────────────────────────────────────────────────

  conductorCmd
    .command("start")
    .description("Start the arkd agent daemon")
    .option("-p, --port <port>", "Port", "19300")
    .option("--hostname <host>", "Bind address", "0.0.0.0")
    .option("--conductor-url <url>", "Conductor URL for channel relay")
    .option(
      "--workspace-root <path>",
      "Confine /file/* and /exec to this directory (recommended in hosted / multi-tenant deployments)",
    )
    .option("-d, --detach", "Run in background (detached mode)")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      const host = opts.hostname;

      // Check if daemon is already running
      const existing = readPidFile();
      if (existing && isProcessRunning(existing.pid)) {
        console.log(chalk.yellow(`Daemon already running (pid ${existing.pid}, port ${existing.port})`));
        console.log(chalk.dim("Use 'ark conductor stop' to stop it first."));
        return;
      }

      // Clean up stale PID file
      if (existing) removePidFile();

      if (opts.detach) {
        // Background mode: spawn a detached child process running ark conductor
        // start (without --detach). Use the shared self-spawn helper so this
        // works from a compiled bundle (where argv[1] is /\$bunfs/... and
        // there's no external `bun` to invoke).
        const args = ["conductor", "start", "--port", String(port), "--hostname", host];
        if (opts.conductorUrl) args.push("--conductor-url", opts.conductorUrl);
        if (opts.workspaceRoot) args.push("--workspace-root", opts.workspaceRoot);

        const { arkSelfSpawnCmd } = await import("../helpers.js");
        const proc = Bun.spawn({
          cmd: arkSelfSpawnCmd(args),
          stdio: ["ignore", "ignore", "ignore"],
          env: { ...process.env },
        });

        // Unref so this parent can exit
        proc.unref();

        // Give the child a moment to start, then verify
        await new Promise((r) => setTimeout(r, 500));

        // Try to reach the daemon
        try {
          const resp = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
          if (resp.ok) {
            console.log(chalk.green(`Daemon started in background (pid ${proc.pid}, port ${port})`));
          } else {
            console.log(
              chalk.yellow(`Daemon process spawned (pid ${proc.pid}) but health check returned ${resp.status}`),
            );
          }
        } catch {
          // Process started but health not reachable yet -- still write PID
          console.log(chalk.green(`Daemon process spawned (pid ${proc.pid}, port ${port})`));
          console.log(chalk.dim("Health endpoint not yet reachable -- daemon may still be starting."));
        }

        // Write PID file from parent so it's available immediately
        writePidFile({
          pid: proc.pid,
          port,
          hostname: host,
          startedAt: new Date().toISOString(),
        });
        return;
      }

      // Foreground mode
      const { startArkd } = await import("../../arkd/server/index.js");
      const { DEFAULT_CONDUCTOR_URL } = await import("../../core/constants.js");
      const conductorUrl = opts.conductorUrl || DEFAULT_CONDUCTOR_URL;

      writePidFile({
        pid: process.pid,
        port,
        hostname: host,
        startedAt: new Date().toISOString(),
      });

      const daemon = startArkd(port, {
        conductorUrl,
        hostname: host,
        workspaceRoot: opts.workspaceRoot,
      });

      console.log(chalk.green(`Daemon started on ${host}:${port} (pid ${process.pid})`));
      console.log(chalk.dim("Press Ctrl+C to stop"));

      const shutdown = () => {
        console.log(chalk.dim("\nStopping daemon..."));
        daemon.stop();
        removePidFile();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Keep alive
      await new Promise(() => {});
    });

  // ── conductor stop ────────────────────────────────────────────────────────

  conductorCmd
    .command("stop")
    .description("Stop a running arkd daemon")
    .option("-p, --port <port>", "Port of daemon to stop (uses PID file by default)")
    .action(async (opts) => {
      const info = readPidFile();

      if (opts.port) {
        // Stop by port -- try graceful shutdown via health check first, then signal
        const port = parseInt(opts.port, 10);
        if (info && info.port === port && isProcessRunning(info.pid)) {
          process.kill(info.pid, "SIGTERM");
          removePidFile();
          console.log(chalk.green(`Stopped daemon (pid ${info.pid}, port ${port})`));
          return;
        }
        // No PID file match -- try to find the process by port
        console.log(chalk.yellow(`No tracked daemon on port ${port}. Use 'ark conductor status' to check.`));
        return;
      }

      if (!info) {
        console.log(chalk.yellow("No daemon PID file found. Is the daemon running?"));
        return;
      }

      if (!isProcessRunning(info.pid)) {
        console.log(chalk.yellow(`Daemon (pid ${info.pid}) is not running. Cleaning up stale PID file.`));
        removePidFile();
        return;
      }

      process.kill(info.pid, "SIGTERM");
      removePidFile();
      console.log(chalk.green(`Stopped daemon (pid ${info.pid}, port ${info.port})`));
    });

  // ── conductor status ──────────────────────────────────────────────────────

  conductorCmd
    .command("status")
    .description("Check arkd daemon status and conductor liveness")
    .option("-p, --port <port>", "Port to check", "19300")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      const info = readPidFile();

      // Check PID file first
      if (info) {
        const running = isProcessRunning(info.pid);
        if (!running) {
          console.log(chalk.yellow(`Daemon (pid ${info.pid}) has exited. Cleaning up stale PID file.`));
          removePidFile();
        }
      }

      // Try to reach the health endpoint
      try {
        const resp = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (resp.ok) {
          const data = (await resp.json()) as { status: string; version: string; hostname: string; platform: string };
          console.log(chalk.green("Daemon is running"));
          console.log(`  Port:     ${port}`);
          console.log(`  Version:  ${data.version}`);
          console.log(`  Host:     ${data.hostname}`);
          console.log(`  Platform: ${data.platform}`);
          if (info && isProcessRunning(info.pid)) {
            console.log(`  PID:      ${info.pid}`);
            console.log(`  Started:  ${info.startedAt}`);
          }
          return;
        }
      } catch {
        logDebug("general", "Not reachable");
      }

      console.log(chalk.yellow(`Daemon is not running on port ${port}`));
      if (info && info.port !== port) {
        console.log(chalk.dim(`PID file indicates port ${info.port} -- try: ark conductor status --port ${info.port}`));
      }
    });

  // ── conductor learnings ───────────────────────────────────────────────────

  conductorCmd
    .command("learnings")
    .description("Show conductor learnings")
    .action(async () => {
      const ark = await getArkClient();
      const { learnings } = await ark.conductorLearnings();

      if (learnings.length === 0) {
        console.log(chalk.dim("No learnings yet. The conductor records patterns during orchestration."));
        return;
      }

      const promoted = learnings.filter((l) => l.promoted);
      const active = learnings.filter((l) => !l.promoted);

      if (promoted.length > 0) {
        console.log(chalk.bold("\nPolicies (promoted from learnings):\n"));
        for (const p of promoted) {
          console.log(`  ${chalk.green("✓")} ${chalk.bold(p.title)}`);
          if (p.description) console.log(`    ${chalk.dim(p.description.split("\n")[0])}`);
        }
      }

      if (active.length > 0) {
        console.log(chalk.bold("\nActive learnings:\n"));
        for (const l of active) {
          const rec = Math.max(1, Math.min(3, l.recurrence));
          const bar = "█".repeat(rec) + "░".repeat(3 - rec);
          console.log(`  ${bar} ${chalk.bold(l.title)} (seen ${l.recurrence}x)`);
          if (l.description) console.log(`    ${chalk.dim(l.description.split("\n")[0])}`);
        }
      }
    });

  // ── conductor learn ───────────────────────────────────────────────────────

  conductorCmd
    .command("learn")
    .description("Record a conductor learning")
    .argument("<title>")
    .argument("[description]")
    .action(async (title: string, description?: string) => {
      const ark = await getArkClient();
      const { learning } = await ark.conductorLearn({ title, description });
      if (learning.promoted) {
        console.log(chalk.green(`Promoted to policy: ${title} (recurrence: ${learning.recurrence})`));
      } else {
        console.log(chalk.blue(`Recorded: ${title} (recurrence: ${learning.recurrence}/3)`));
      }
    });

  // ── conductor bridge ──────────────────────────────────────────────────────

  conductorCmd
    .command("bridge")
    .description("Start the messaging bridge (Slack/email) on the daemon")
    .action(async () => {
      const ark = await getArkClient();
      const result = await ark.conductorBridge();
      if (!result.ok) {
        console.log(chalk.red(result.message ?? "Bridge failed to start"));
        console.log(chalk.dim("\nExample ~/.ark/bridge.json:"));
        console.log(
          chalk.dim(
            JSON.stringify(
              {
                slack: { webhookUrl: "https://hooks.slack.com/services/..." },
                email: {
                  host: "smtp.gmail.com",
                  port: 587,
                  secure: false,
                  auth: { user: "ark@example.com", pass: "app-password" },
                  from: "Ark <ark@example.com>",
                  to: "ops@example.com",
                },
              },
              null,
              2,
            ),
          ),
        );
        return;
      }
      console.log(chalk.green("Bridge started on the daemon. It will continue to run in the background."));
    });

  // ── conductor notify ──────────────────────────────────────────────────────

  conductorCmd
    .command("notify")
    .description("Send a test notification via bridge")
    .argument("<message>")
    .action(async (message: string) => {
      const ark = await getArkClient();
      const result = await ark.conductorNotify(message);
      if (!result.ok) {
        console.log(chalk.red(result.message ?? "No bridge config. Create ~/.ark/bridge.json"));
        return;
      }
      console.log(chalk.green("Notification sent"));
    });
}
