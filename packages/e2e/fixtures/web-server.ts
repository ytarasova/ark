/**
 * Boots an `ark web` subprocess for Playwright tests.
 *
 * - Calls setupE2E() to get isolated AppContext + temp dir
 * - Builds web frontend via `bun run packages/web/build.ts`
 * - Spawns `ark web --port <random>` with ARK_TEST_DIR env var
 * - Polls /api/status until server is ready (20s timeout)
 * - Returns { port, baseUrl, env, serverProcess, teardown }
 */

import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { setupE2E, type E2EEnv } from "./app.js";

const ARK_BIN = join(import.meta.dir, "..", "..", "..", "ark");

// Track every spawned server so we can reap orphans on host exit.
// Without this, a Playwright worker that dies mid-test leaks `ark web`
// subprocesses to launchd (they survive as immortal zombies until the
// box reboots -- we've seen 100+ accumulate over a day of flaky runs).
const LIVE_SERVERS = new Set<Subprocess>();
let exitHookInstalled = false;

function killServer(proc: Subprocess): void {
  try {
    proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  LIVE_SERVERS.delete(proc);
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const reap = () => {
    for (const proc of LIVE_SERVERS) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    LIVE_SERVERS.clear();
  };
  process.on("exit", reap);
  process.on("SIGINT", () => {
    reap();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    reap();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    reap();
    throw err;
  });
}

export interface WebServerEnv {
  port: number;
  baseUrl: string;
  env: E2EEnv;
  serverProcess: Subprocess;
  teardown: () => Promise<void>;
  /** Send a JSON-RPC request to the web server and return the parsed result. */
  rpc: <T = any>(method: string, params?: Record<string, unknown>) => Promise<T>;
  /** Send a JSON-RPC request and return the raw response (for status checks). */
  rpcRaw: (method: string, params?: Record<string, unknown>) => Promise<Response>;
}

function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

async function pollReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "status/get", params: {} }),
      });
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`Web server did not become ready within ${timeoutMs}ms`);
}

export async function setupWebServer(): Promise<WebServerEnv> {
  installExitHook();
  const env = await setupE2E();

  // Build web frontend
  const buildResult = spawn(["bun", "run", "packages/web/build.ts"], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  await buildResult.exited;
  if (buildResult.exitCode !== 0) {
    const stderr = await new Response(buildResult.stderr).text();
    throw new Error(`Web build failed: ${stderr}`);
  }

  const port = randomPort();
  const baseUrl = `http://localhost:${port}`;

  const serverProcess = spawn([ARK_BIN, "web", "--port", String(port)], {
    cwd: join(import.meta.dir, "..", "..", ".."),
    env: {
      ...process.env,
      ARK_TEST_DIR: env.app.arkDir,
      // Belt-and-suspenders against orphan leak: if Playwright SIGKILLs this
      // worker (timeout, whole-run abort), our in-process reap hooks do not
      // fire. The child's parent-death watchdog notices ppid -> 1 and exits.
      ARK_WATCH_PARENT: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  LIVE_SERVERS.add(serverProcess);

  try {
    await pollReady(baseUrl);
  } catch (err) {
    killServer(serverProcess);
    await env.teardown();
    throw err;
  }

  let rpcId = 0;

  async function rpcRaw(method: string, params: Record<string, unknown> = {}): Promise<Response> {
    return fetch(`${baseUrl}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
  }

  async function rpc<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const res = await rpcRaw(method, params);
    const data = (await res.json()) as any;
    if (data.error) throw new Error(data.error.message || "RPC error");
    return data.result as T;
  }

  return {
    port,
    baseUrl,
    env,
    serverProcess,
    rpc,
    rpcRaw,
    teardown: async () => {
      // SIGTERM first for a clean shutdown, then SIGKILL after 500ms if the
      // subprocess is hung mid-boot or ignoring signals.
      try {
        serverProcess.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      const killed = await Promise.race([
        serverProcess.exited.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 500)),
      ]);
      if (!killed) {
        try {
          serverProcess.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
      LIVE_SERVERS.delete(serverProcess);
      await env.teardown();
    },
  };
}
