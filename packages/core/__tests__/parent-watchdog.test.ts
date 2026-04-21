/**
 * Verifies the ARK_WATCH_PARENT=1 parent-death watchdog inside `ark web`.
 *
 * Repro:
 *   1. Spawn `./ark web --port <free>` with ARK_WATCH_PARENT=1. The `./ark`
 *      bash wrapper forks `bun packages/cli/index.ts web` as a child.
 *   2. Wait for the web server to respond on the port (== the watchdog's
 *      setInterval is armed).
 *   3. SIGKILL the bash wrapper with `proc.kill("SIGKILL")`. Bash dies
 *      without reaping; bun reparents to PID 1 on macOS/Linux.
 *   4. Within one watchdog tick (2s) + margin, the bun child should log
 *      "parent process died" and exit(0), releasing the port.
 *   5. Assert the port stops responding within ~8s.
 *
 * Without the watchdog the bun process would survive as an immortal zombie
 * holding the port until reboot, which is exactly the leak we are plugging.
 */

import { describe, it, expect } from "bun:test";
import { spawn } from "bun";
import { join } from "path";
import { createServer } from "net";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ARK_BIN = join(REPO_ROOT, "ark");

// Inline port allocator: bind :0, read assigned port, close. Ephemeral port
// range; small TOCTOU window but fine for a one-shot test. (The dedicated
// port-allocator helper lands in the app-config PR we are not touching here.)
async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "0.0.0.0", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("port allocator: unexpected address type"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

async function portResponds(port: number, timeoutMs = 500): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "status/get", params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok || res.status >= 400;
  } catch {
    return false;
  }
}

async function waitUntilReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portResponds(port)) return true;
    await Bun.sleep(200);
  }
  return false;
}

async function waitUntilGone(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portResponds(port))) return true;
    await Bun.sleep(200);
  }
  return false;
}

describe("ARK_WATCH_PARENT parent-death watchdog", async () => {
  it("exits ark web child process when the spawner is SIGKILLed", async () => {
    const port = await allocatePort();

    // --api-only skips the static-asset build and serves only /api/*, which
    // is plenty to exercise the watchdog.
    const proc = spawn([ARK_BIN, "web", "--api-only", "--port", String(port)], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ARK_WATCH_PARENT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      // Wait for web server boot (server build + bun startup).
      const ready = await waitUntilReady(port, 30_000);
      expect(ready).toBe(true);

      // Kill the bash wrapper. Bun (the grandchild running the actual
      // server) reparents to PID 1, watchdog fires within ~2s.
      proc.kill("SIGKILL");

      // Generous margin for the 2s polling interval + event loop drain.
      const gone = await waitUntilGone(port, 10_000);
      expect(gone).toBe(true);
    } finally {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 60_000);
});
