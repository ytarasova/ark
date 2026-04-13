/**
 * Ark Daemon entry point.
 *
 * Boots AppContext (DB, conductor, arkd) + WebSocket JSON-RPC server as a
 * long-lived background process. Clients (TUI, CLI, web) connect via
 * WebSocket instead of each booting their own AppContext.
 *
 * Boot sequence:
 *   1. Check lockfile -- abort if daemon already running
 *   2. loadConfig() + new AppContext()
 *   3. app.boot() (starts conductor + arkd)
 *   4. ArkServer + registerAllHandlers + startWebSocket(port)
 *   5. Optionally startWebServer() for the web dashboard
 *   6. writeLockfile()
 *   7. Register SIGINT/SIGTERM for graceful shutdown
 */

import { AppContext, setApp } from "../core/app.js";
import { loadConfig } from "../core/config.js";
import { ArkServer } from "../server/index.js";
import { registerAllHandlers } from "../server/register.js";
import { DEFAULT_DAEMON_WS_PORT } from "../core/constants.js";
import { writeLockfile, removeLockfile, isDaemonRunning } from "./lockfile.js";
import { eventBus } from "../core/hooks.js";

export interface DaemonOptions {
  /** WebSocket server port (default: 19400) */
  wsPort?: number;
  /** Start the web dashboard on this port (omit to skip) */
  webPort?: number;
  /** Suppress startup banner */
  quiet?: boolean;
}

export interface DaemonHandle {
  app: AppContext;
  server: ArkServer;
  wsStop: () => void;
  webStop?: () => void;
  shutdown: () => Promise<void>;
}

/**
 * Start the daemon. Returns a handle for programmatic control (tests, CLI).
 * Throws if another daemon is already running.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  const config = loadConfig();
  const arkDir = config.arkDir;
  const wsPort = options.wsPort ?? DEFAULT_DAEMON_WS_PORT;

  // 1. Check for existing daemon
  const { running, info: existingInfo } = isDaemonRunning(arkDir);
  if (running) {
    throw new Error(
      `Daemon already running (pid ${existingInfo!.pid}, ws ${existingInfo!.ws_url}). ` +
      `Stop it with: ark daemon stop`
    );
  }

  // 2. Boot AppContext (conductor + arkd started by app.boot())
  const app = new AppContext(config);
  setApp(app);
  await app.boot();

  // 3. Start WS JSON-RPC server
  const server = new ArkServer();
  registerAllHandlers(server.router, app);
  const { stop: wsStop } = server.startWebSocket(wsPort);

  // 4. Bridge eventBus -> WS notifications
  // The conductor emits events via eventBus; bridge them to connected WS clients
  // so they get real-time updates (session state changes, hook status, etc.)
  const busEvents = [
    "session_updated", "session_completed", "session_failed",
    "session_dispatched", "session_stopped", "session_stage_changed",
    "hook_status", "event_logged", "compute_updated",
  ];
  const unsubscribers: Array<() => void> = [];
  for (const event of busEvents) {
    const unsub = eventBus.on(event, (data: any) => {
      server.notify(`event/${event}`, { event, ...(data || {}) });
    });
    unsubscribers.push(unsub);
  }

  // 5. Optionally start web server
  let webStop: (() => void) | undefined;
  if (options.webPort) {
    const { startWebServer } = await import("../core/hosted/web.js");
    const webServer = startWebServer(app, { port: options.webPort });
    webStop = () => webServer.stop();
    if (!options.quiet) {
      console.log(`  Web dashboard: http://localhost:${options.webPort}`);
    }
  }

  // 6. Write lockfile
  writeLockfile(arkDir, {
    pid: process.pid,
    ws_url: `ws://127.0.0.1:${wsPort}`,
    conductor_port: config.conductorPort,
    arkd_port: config.arkdPort ?? 19300,
    web_port: options.webPort,
    started_at: new Date().toISOString(),
  });

  // 7. Build shutdown function
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    // Detach event bus listeners
    for (const unsub of unsubscribers) unsub();

    wsStop();
    if (webStop) webStop();
    removeLockfile(arkDir);
    await app.shutdown();
  };

  if (!options.quiet) {
    console.log(`Ark daemon started (pid ${process.pid})`);
    console.log(`  WebSocket: ws://127.0.0.1:${wsPort}`);
    console.log(`  Conductor: http://localhost:${config.conductorPort}`);
    console.log(`  Arkd:      http://localhost:${config.arkdPort ?? 19300}`);
  }

  return { app, server, wsStop, webStop, shutdown };
}
