import type { Command } from "commander";
import chalk from "chalk";
import { join } from "path";
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "fs";
import { homedir } from "os";
import { logDebug } from "../../core/observability/structured-log.js";

/** Path to the PID file for the server daemon. */
function pidFilePath(arkDir?: string): string {
  return join(arkDir ?? join(homedir(), ".ark"), "server.pid");
}

interface ServerPidInfo {
  pid: number;
  port: number;
  startedAt: string;
}

function readPidFile(arkDir?: string): ServerPidInfo | null {
  const pidPath = pidFilePath(arkDir);
  if (!existsSync(pidPath)) return null;
  try {
    return JSON.parse(readFileSync(pidPath, "utf-8")) as ServerPidInfo;
  } catch {
    return null;
  }
}

function writePidFile(info: ServerPidInfo, arkDir?: string): void {
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

async function probeHealth(port: number, timeoutMs = 2000): Promise<{ ok: boolean; data?: any }> {
  try {
    const resp = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (resp.ok) {
      const data = await resp.json();
      return { ok: true, data };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export function registerServerDaemonCommands(serverCmd: Command) {
  const daemonCmd = serverCmd.command("daemon").description("Manage the Ark server daemon");

  // ── daemon start ──────────────────────────────────────────────────────────

  daemonCmd
    .command("start")
    .description("Start the Ark server daemon (AppContext + conductor + arkd + WebSocket)")
    .option("-p, --port <port>", "WebSocket server port", "19400")
    .option("-d, --detach", "Run in background (detached mode)")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);

      // Check if daemon is already running
      const existing = readPidFile();
      if (existing && isProcessRunning(existing.pid)) {
        const health = await probeHealth(existing.port);
        if (health.ok) {
          console.log(chalk.yellow(`Server daemon already running (pid ${existing.pid}, port ${existing.port})`));
          console.log(chalk.dim("Use 'ark server daemon stop' to stop it first."));
          return;
        }
        // Process exists but not responding -- stale
        console.log(chalk.dim(`Cleaning stale PID file (pid ${existing.pid} not responding)`));
        removePidFile();
      } else if (existing) {
        removePidFile();
      }

      // Also check if something is already listening on the port
      const portCheck = await probeHealth(port);
      if (portCheck.ok) {
        console.log(chalk.yellow(`Port ${port} is already in use (another server running?)`));
        console.log(chalk.dim("Use --port to specify a different port, or stop the existing server."));
        return;
      }

      if (opts.detach) {
        // Background mode: spawn a detached child via the shared helper.
        // Compiled bundles need exec(execPath); source-tree dev needs `bun`.
        const { arkSelfSpawnCmd } = await import("../helpers.js");
        const cmd = arkSelfSpawnCmd(["server", "daemon", "start", "--port", String(port)]);

        const proc = Bun.spawn({
          cmd,
          stdio: ["ignore", "ignore", "ignore"],
          env: { ...process.env },
        });

        proc.unref();

        // Write PID file immediately so the caller can find it
        writePidFile({ pid: proc.pid, port, startedAt: new Date().toISOString() });

        // Poll health until ready (up to 10s)
        const deadline = Date.now() + 10000;
        let healthy = false;
        while (Date.now() < deadline) {
          await Bun.sleep(500);
          const check = await probeHealth(port);
          if (check.ok) {
            healthy = true;
            break;
          }
        }

        if (healthy) {
          console.log(chalk.green(`Server daemon started (pid ${proc.pid}, port ${port})`));
        } else {
          console.log(chalk.yellow(`Server daemon spawned (pid ${proc.pid}) but health check not yet passing`));
          console.log(chalk.dim("Check 'ark server daemon status' in a moment."));
        }
        return;
      }

      // Foreground mode: boot everything in-process
      const { AppContext } = await import("../../core/app.js");
      const { loadConfig } = await import("../../core/config.js");
      const { ArkServer } = await import("../../server/index.js");
      const { registerAllHandlers } = await import("../../server/register.js");

      const config = loadConfig();

      // Warn if ARK_TEST_DIR is set -- this causes the daemon to use a different
      // database than the default ~/.ark/ark.db, which can silently break session
      // dispatch and stage advancement.
      if (process.env.ARK_TEST_DIR) {
        console.log(chalk.yellow(`WARNING: ARK_TEST_DIR is set (${process.env.ARK_TEST_DIR})`));
        console.log(chalk.yellow(`Daemon will use ${config.dirs.ark} instead of ~/.ark`));
        console.log(chalk.yellow(`Unset ARK_TEST_DIR if this is not intentional.`));
      }

      const app = new AppContext(config);
      await app.boot();

      const server = new ArkServer();
      registerAllHandlers(server.router, app);
      server.attachLifecycle(app);
      server.attachAuth(app);
      server.attachApp(app);

      const ws = server.startWebSocket(port, { app });

      writePidFile({ pid: process.pid, port, startedAt: new Date().toISOString() });

      console.log(chalk.green(`Ark server daemon started (pid ${process.pid})`));
      console.log(chalk.dim(`  WebSocket:  ws://localhost:${port}`));
      console.log(chalk.dim(`  Health:     http://localhost:${port}/health`));
      console.log(chalk.dim(`  Conductor:  http://localhost:${config.ports.conductor}`));
      console.log(chalk.dim("Press Ctrl+C to stop"));

      const shutdown = async () => {
        console.log(chalk.dim("\nStopping server daemon..."));
        ws.stop();
        await app.shutdown();
        removePidFile();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Ignore SIGPIPE explicitly. macOS default action on SIGPIPE is
      // TERMINATE -- writes to a socket whose peer closed (SSM session
      // disconnect, port-forward mid-stream hiccup, fetch peer reset)
      // crash the daemon with NO graceful shutdown, NO uncaughtException
      // (signals don't go through the JS exception path), NO crash report.
      // Node ignores SIGPIPE by default; Bun does not. Live evidence: every
      // EC2 dispatch died silently at +125-130s with no logged error and
      // no shutdown message, while local dispatch on the same daemon ran
      // for 7+ minutes through full stage transitions.
      process.on("SIGPIPE", () => {
        // No-op: install a JS handler so the kernel default (terminate)
        // is bypassed.
      });

      // Daemon-stability guard. Without these, an unhandled rejection or
      // uncaughtException anywhere in the dispatch chain (an orphaned
      // `provider.launch` after a watchdog wins, a stream-error escaping
      // a child-process pipe, etc.) crashes the bun process. Live evidence:
      // every EC2 dispatch attempt killed the daemon ~108s in despite the
      // dispatch-layer try/catch chain. Logging + survival here is strictly
      // better than the silent-restart we had before.
      process.on("unhandledRejection", (reason, promise) => {
        const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
        console.error(`[daemon] unhandledRejection: ${msg}`);
        void (promise as Promise<unknown>)?.catch?.(() => {});
      });
      process.on("uncaughtException", (err) => {
        console.error(`[daemon] uncaughtException: ${err.stack ?? err.message}`);
      });

      // Keep alive
      await new Promise(() => {});
    });

  // ── daemon stop ───────────────────────────────────────────────────────────

  daemonCmd
    .command("stop")
    .description("Stop the server daemon")
    .action(async () => {
      const info = readPidFile();

      if (!info) {
        console.log(chalk.yellow("No server daemon PID file found. Is the daemon running?"));
        return;
      }

      if (!isProcessRunning(info.pid)) {
        console.log(chalk.yellow(`Server daemon (pid ${info.pid}) is not running. Cleaning up stale PID file.`));
        removePidFile();
        return;
      }

      process.kill(info.pid, "SIGTERM");
      removePidFile();
      console.log(chalk.green(`Stopped server daemon (pid ${info.pid}, port ${info.port})`));
    });

  // ── daemon status ─────────────────────────────────────────────────────────

  daemonCmd
    .command("status")
    .description("Check server daemon status")
    .action(async () => {
      const info = readPidFile();

      // Check PID file first
      if (info && !isProcessRunning(info.pid)) {
        console.log(chalk.yellow(`Server daemon (pid ${info.pid}) has exited. Cleaning up stale PID file.`));
        removePidFile();
      }

      if (info && isProcessRunning(info.pid)) {
        const health = await probeHealth(info.port);
        if (health.ok) {
          console.log(chalk.green("Server daemon is running"));
          console.log(`  Port:    ${info.port}`);
          console.log(`  PID:     ${info.pid}`);
          console.log(`  Started: ${info.startedAt}`);
          if (health.data?.uptime) console.log(`  Uptime:  ${Math.round(health.data.uptime)}s`);
          return;
        }
        console.log(chalk.yellow(`Server daemon process exists (pid ${info.pid}) but health check failed`));
        return;
      }

      // No PID file or dead process -- try default port anyway
      const { DEFAULT_CONDUCTOR_PORT } = await import("../../core/constants.js");
      const health = await probeHealth(DEFAULT_CONDUCTOR_PORT);
      if (health.ok) {
        console.log(chalk.green(`Server daemon is running on port ${DEFAULT_CONDUCTOR_PORT} (no PID file)`));
        if (health.data?.pid) console.log(`  PID:    ${health.data.pid}`);
        if (health.data?.uptime) console.log(`  Uptime: ${Math.round(health.data.uptime)}s`);
        return;
      }

      console.log(chalk.yellow("Server daemon is not running"));
    });
}
