/**
 * Spawn the real `ark server start --hosted` binary and wait for /api/health.
 *
 * The test interacts with this server only via HTTP -- never imports
 * AppContext directly -- so any DI wiring bug in hosted boot surfaces as a
 * test failure rather than being papered over by the test harness sharing
 * objects with production code.
 */

import type { Subprocess } from "bun";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Best-effort kill of any process holding the given TCP ports. Used to
 * recover from a prior test run that crashed before tearing down the
 * server -- the volumes get wiped via `down -v` but the bun process can
 * outlive that and keep the port bound. Silent on failure: if the port
 * is already free or `lsof` is missing the next bind attempt will surface
 * the real error.
 */
async function clearStalePorts(ports: number[]): Promise<void> {
  for (const port of ports) {
    const lsof = Bun.spawn(["lsof", "-ti", `:${port}`], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(lsof.stdout).text();
    await lsof.exited;
    const pids = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        // process already gone
      }
    }
  }
  if (ports.length) await Bun.sleep(200);
}

export interface ServerHandle {
  proc: Subprocess;
  webUrl: string;
}

export interface SpawnOptions {
  /** Absolute path to a temp arkDir. Required so blobs/snapshots don't
   *  pollute the operator's ~/.ark. */
  arkDir: string;
  /** Path to .env.e2e. Read and parsed in this process; we set the keys
   *  on the child env explicitly so we have one source of truth. */
  envFile: string;
  /** ms to wait for /api/health before giving up. */
  startupTimeoutMs?: number;
}

function parseEnvFile(path: string): Record<string, string> {
  const raw = readFileSync(path, "utf-8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export async function spawnServer(opts: SpawnOptions): Promise<ServerHandle> {
  const fileEnv = parseEnvFile(opts.envFile);
  const env: Record<string, string> = { ...process.env, ...fileEnv, ARK_DIR: opts.arkDir } as Record<string, string>;
  const repoRoot = resolve(import.meta.dir, "../..");

  // Free any ports left bound by a prior test run that crashed before
  // tearing down the server. Without this, EADDRINUSE on bind() kills
  // boot before /api/health is reachable.
  const portsToClear = [
    fileEnv.ARK_WEB_PORT,
    fileEnv.ARK_CONDUCTOR_PORT,
    fileEnv.ARK_ARKD_PORT,
    fileEnv.ARK_SERVER_PORT,
  ]
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => Number(p))
    .filter((n) => Number.isFinite(n));
  await clearStalePorts(portsToClear);

  const proc = Bun.spawn(["bun", "packages/cli/index.ts", "server", "start", "--hosted"], {
    cwd: repoRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });

  const webPort = fileEnv.ARK_WEB_PORT ?? "8422";
  const webUrl = `http://localhost:${webPort}`;

  const deadline = Date.now() + (opts.startupTimeoutMs ?? 30_000);
  // Stage 1: wait for the lightweight /api/health probe -- proves the
  // web server is listening but says nothing about DB readiness.
  let healthy = false;
  while (!healthy && Date.now() < deadline) {
    try {
      const r = await fetch(`${webUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      // server not up yet
    }
    await Bun.sleep(250);
  }
  if (!healthy) {
    proc.kill();
    throw new Error(`ark server health check failed at ${webUrl}/api/health within budget`);
  }
  // Stage 2: wait for a real RPC to succeed against the DB. /api/health
  // returns 200 the moment Bun.serve binds the port, but `app.boot()` (which
  // runs migrations) is still racing in the background. Hammering /api/rpc
  // before migrations finish surfaces as Drizzle "table not found" errors.
  // session/list is read-only and cheap; success here means the schema is in
  // place and the dispatcher chain is wired.
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${webUrl}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "boot-probe", method: "session/list", params: { limit: 1 } }),
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) {
        const body = (await r.json()) as { error?: unknown };
        if (!body.error) return { proc, webUrl };
      }
    } catch {
      // migrations still running, retry
    }
    await Bun.sleep(500);
  }
  proc.kill();
  throw new Error(`ark server DB-ready probe failed at ${webUrl}/api/rpc session/list within budget`);
}

export async function killServer(handle: ServerHandle): Promise<void> {
  // SIGTERM first -- gives the server a chance to clear timers, drain
  // SSE clients, and disconnect the postgres pool cleanly. The hosted
  // server's broadcastSessions setInterval is what holds the bun event
  // loop open, so without an explicit clear it will outlive SIGTERM if
  // the server's own SIGTERM handler is missing or slow.
  handle.proc.kill("SIGTERM");
  const graceful = Promise.race([
    handle.proc.exited,
    Bun.sleep(2000).then(() => "timeout" as const),
  ]);
  const result = await graceful;
  if (result === "timeout") {
    handle.proc.kill("SIGKILL");
    await handle.proc.exited;
  }
}
