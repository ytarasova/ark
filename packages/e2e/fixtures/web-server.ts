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

export interface WebServerEnv {
  port: number;
  baseUrl: string;
  env: E2EEnv;
  serverProcess: Subprocess;
  teardown: () => Promise<void>;
}

function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

async function pollReady(baseUrl: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/status`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await Bun.sleep(250);
  }
  throw new Error(`Web server did not become ready within ${timeoutMs}ms`);
}

export async function setupWebServer(): Promise<WebServerEnv> {
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
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    await pollReady(baseUrl);
  } catch (err) {
    serverProcess.kill();
    await env.teardown();
    throw err;
  }

  return {
    port,
    baseUrl,
    env,
    serverProcess,
    teardown: async () => {
      serverProcess.kill();
      await env.teardown();
    },
  };
}
