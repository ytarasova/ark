/**
 * Single entry point for obtaining an `ArkClient` from any CLI command.
 *
 * Decides between three transports, in precedence order:
 *
 *   1. Remote: `--server <url>` or `ARK_SERVER` env var -- connect to an
 *      external control plane over WebSocket, auth via `--token` / `ARK_TOKEN`.
 *   2. Already-running local daemon: if the server port responds to GET
 *      /health, connect to `ws://localhost:<server-port>/ws`.
 *   3. Auto-spawn: fork `ark server daemon start --detach --port <p>` as a
 *      background subprocess, poll /health until it responds, then connect
 *      via WebSocket.
 *
 * This is the ONLY module that decides local-spawn vs. remote-connect.
 * Every command file obtains its client via `getArkClient()`; no command
 * file reaches into the transport / daemon layer directly.
 *
 * In-process mode (booting a local AppContext + in-memory transport) is
 * retained as a fallback when the port is already occupied by a non-Ark
 * listener but the caller has explicitly opted in via ARK_INPROCESS=1 --
 * used by the cli test suite so tests can stand up a daemon without
 * spawning another process. Production / interactive usage always goes
 * through the detach + health-poll path.
 */

import { ArkClient } from "../protocol/client.js";
import { createWebSocketTransport } from "../protocol/transport.js";
import { logDebug } from "../core/observability/structured-log.js";
import type { AppContext } from "../core/app.js";

let _client: ArkClient | null = null;
let _remoteServerUrl: string | undefined;
let _remoteToken: string | undefined;
let _port: number | undefined;
let _localApp: AppContext | null = null;

/** Called from index.ts to configure remote mode before any commands run. */
export function setRemoteServer(url: string | undefined, token: string | undefined): void {
  _remoteServerUrl = url;
  _remoteToken = token;
}

/** Override the server port (defaults to config.ports.server / 19400). */
export function setServerPort(port: number | undefined): void {
  _port = port;
}

/** Returns true when operating in remote mode. */
export function isRemoteMode(): boolean {
  return !!(_remoteServerUrl || process.env.ARK_SERVER);
}

/**
 * Default port for the local server daemon. Mirrors config.ports.server.
 * Kept as a standalone helper so we do not have to boot a full AppConfig
 * just to discover the port.
 */
function defaultServerPort(): number {
  if (_port) return _port;
  const env = process.env.ARK_SERVER_PORT;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 19400;
}

async function probeHealth(port: number, timeoutMs = 600): Promise<boolean> {
  try {
    const resp = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Spawn `ark server daemon start --detach` as a background subprocess and
 * poll /health until it responds or we give up. Returns true when the
 * daemon is healthy.
 */
async function spawnLocalDaemon(port: number, deadlineMs = 10000): Promise<boolean> {
  // Use the shared helper so the compiled-bundle vs source detection lives
  // in one place (helpers.ts:arkSelfSpawnCmd).
  let cmd: string[];
  try {
    const { arkSelfSpawnCmd } = await import("./helpers.js");
    cmd = arkSelfSpawnCmd(["server", "daemon", "start", "--port", String(port)]);
  } catch (err) {
    logDebug("general", `daemon spawn cmd resolution failed: ${(err as Error).message}`);
    return false;
  }
  try {
    const proc = Bun.spawn({
      cmd,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });
    proc.unref();
  } catch (err) {
    logDebug("general", `daemon spawn failed: ${(err as Error).message}`);
    return false;
  }

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probeHealth(port, 500)) return true;
    await Bun.sleep(150);
  }
  return false;
}

/**
 * Resolve an ArkClient. Remote mode wins; otherwise try the existing local
 * daemon; otherwise auto-spawn one. Caches the client inside the current
 * process so subsequent calls reuse the same transport.
 */
export async function getArkClient(): Promise<ArkClient> {
  if (_client) return _client;

  const serverUrl = _remoteServerUrl || process.env.ARK_SERVER;
  const token = _remoteToken || process.env.ARK_TOKEN;

  if (serverUrl) {
    return connectWebSocket(serverUrl, token);
  }

  const port = defaultServerPort();

  // Already-running daemon -- connect directly.
  if (await probeHealth(port)) {
    return connectWebSocket(`http://localhost:${port}`, token);
  }

  // Auto-spawn a local daemon. This is the `docker` pattern: the CLI talks
  // only to a daemon; if one isn't running, start it. Target: ~500ms for
  // the first command per session.
  const spawned = await spawnLocalDaemon(port);
  if (!spawned) {
    throw new Error(
      `Unable to reach an Ark daemon on port ${port}, and auto-spawn failed. ` +
        `Start one manually with 'ark server daemon start --detach' or set --server <url>.`,
    );
  }
  return connectWebSocket(`http://localhost:${port}`, token);
}

async function connectWebSocket(baseUrl: string, token: string | undefined): Promise<ArkClient> {
  const wsUrl = baseUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws";
  const { transport, ready } = createWebSocketTransport(wsUrl, { token });
  await ready;

  const client = new ArkClient(transport);
  await client.initialize({ subscribe: ["**"] });
  _client = client;
  return _client;
}

export function closeArkClient(): void {
  if (_client) {
    _client.close();
    _client = null;
  }
}

/**
 * Lazy local-AppContext accessor for command paths that still touch
 * the core in-process (workspace, code-intel, db, exec, dashboard local,
 * hook-runner, etc.). In remote mode this throws -- the caller cannot
 * perform this action against a remote control plane today.
 *
 * Tests that need to inject a pre-booted AppContext can call
 * `setInProcessApp(app)` before invoking commander.
 */
export async function getInProcessApp(): Promise<AppContext> {
  if (isRemoteMode()) {
    throw new Error("This command is not supported against a remote --server; it requires a local AppContext.");
  }
  if (_localApp) return _localApp;
  const { AppContext } = await import("../core/app.js");
  const { loadConfig } = await import("../core/config.js");
  const app = new AppContext(loadConfig(), { skipConductor: true, skipMetrics: true });
  await app.boot();
  _localApp = app;
  return _localApp;
}

/** Pre-seed the in-process AppContext (used by tests). */
export function setInProcessApp(app: AppContext | null): void {
  _localApp = app;
}

/** Shut down any in-process AppContext. Safe to call when nothing is booted. */
export async function shutdownInProcessApp(): Promise<void> {
  if (_localApp) {
    const app = _localApp;
    _localApp = null;
    await app.shutdown();
  }
}

/**
 * Boot a fresh, isolated AppContext for commands like `ark exec` that want
 * the full lifecycle (conductor on, metrics on) without sharing the CLI's
 * cached in-process app. Callers own the returned instance and must call
 * `.shutdown()` themselves.
 */
export async function bootStandaloneApp(): Promise<AppContext> {
  const { AppContext } = await import("../core/app.js");
  const { loadConfig } = await import("../core/config.js");
  const app = new AppContext(loadConfig());
  await app.boot();
  return app;
}
