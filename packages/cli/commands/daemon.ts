import type { Command } from "commander";
import chalk from "chalk";
import { join } from "path";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { homedir } from "os";

/** Path to the PID file for the daemon. */
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
    /* already gone */
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

export function registerDaemonCommands(program: Command) {
  const daemonCmd = program.command("daemon").description("Manage the arkd agent daemon");

  // ── daemon start ──────────────────────────────────────────────────────────

  daemonCmd
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
        console.log(chalk.dim("Use 'ark daemon stop' to stop it first."));
        return;
      }

      // Clean up stale PID file
      if (existing) removePidFile();

      if (opts.detach) {
        // Background mode: spawn a detached child process running ark daemon start (without --detach)
        const arkBin = process.argv[1];
        const args = ["daemon", "start", "--port", String(port), "--hostname", host];
        if (opts.conductorUrl) args.push("--conductor-url", opts.conductorUrl);
        if (opts.workspaceRoot) args.push("--workspace-root", opts.workspaceRoot);

        const proc = Bun.spawn({
          cmd: ["bun", arkBin, ...args],
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
      const { startArkd } = await import("../../arkd/index.js");
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

  // ── daemon stop ───────────────────────────────────────────────────────────

  daemonCmd
    .command("stop")
    .description("Stop a running daemon")
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
        console.log(chalk.yellow(`No tracked daemon on port ${port}. Use 'ark daemon status' to check.`));
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

  // ── daemon status ─────────────────────────────────────────────────────────

  daemonCmd
    .command("status")
    .description("Check daemon status")
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
        // Not reachable
      }

      console.log(chalk.yellow(`Daemon is not running on port ${port}`));
      if (info && info.port !== port) {
        console.log(chalk.dim(`PID file indicates port ${info.port} -- try: ark daemon status --port ${info.port}`));
      }
    });
}
