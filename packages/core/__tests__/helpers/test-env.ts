/**
 * Test environment helpers for parallel-safe test isolation.
 *
 * Every test that boots a real server (arkd, conductor, web, channel) should
 * use these helpers instead of hardcoded ports or shared tmpdirs. This
 * allows `bun test` to run files concurrently without port collisions or
 * stale state bleed-over between tests.
 *
 * Quick reference:
 *
 *   // Single ephemeral port
 *   const port = await allocatePort();
 *
 *   // Several distinct ephemeral ports
 *   const [conductorPort, arkdPort] = await allocatePorts(2);
 *
 *   // Full isolated environment (ports + arkDir + cleanup)
 *   const env = await createTestEnv();
 *   try {
 *     server = startArkd(env.ports.arkd, { quiet: true });
 *     // ... test body ...
 *   } finally {
 *     server.stop();
 *     await env.cleanup();
 *   }
 *
 *   // AppContext + env together
 *   const { app, env } = await createTestApp();
 *   setApp(app); await app.boot();
 */

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "net";
import { AppContext } from "../../app.js";
import type { ArkConfig } from "../../config.js";

// ── Port allocation ────────────────────────────────────────────────────────

/**
 * Allocate a single free TCP port by binding to 0 on the loopback interface,
 * reading the assigned port, then closing the socket. The port is very likely
 * free when the caller goes to bind, though the kernel is free to reassign it
 * under load -- callers that start long-lived servers should use the returned
 * port immediately.
 */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", (err) => reject(err));
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close(() => reject(new Error("allocatePort: no address assigned")));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Allocate N distinct ephemeral ports. The ports are allocated sequentially
 * to guarantee uniqueness within the returned array.
 */
export async function allocatePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  const seen = new Set<number>();
  while (ports.length < n) {
    const p = await allocatePort();
    if (seen.has(p)) continue;
    seen.add(p);
    ports.push(p);
  }
  return ports;
}

// ── Full test environment ──────────────────────────────────────────────────

export interface TestEnvPorts {
  /** Conductor HTTP port. */
  conductor: number;
  /** ArkD HTTP port. */
  arkd: number;
  /** Server daemon WebSocket/HTTP port. */
  server: number;
  /** Web dashboard port. */
  web: number;
}

export interface TestEnv {
  /** Unique tmp ark dir for this test. */
  arkDir: string;
  /** Ports chosen for this test (all guaranteed distinct). */
  ports: TestEnvPorts;
  /** Remove the tmp arkDir. Safe to call multiple times. */
  cleanup: () => Promise<void>;
}

export interface CreateTestEnvOpts {
  /** Optional prefix for the tmpdir name (default: "ark-test-"). */
  arkDirPrefix?: string;
  /** Allocate extra ephemeral ports in addition to the four defaults. */
  extraPorts?: number;
}

/**
 * Create a fully-isolated test environment: tmp ark directory + a fresh set
 * of ephemeral ports for every service. Caller must await `cleanup()` in
 * afterAll/afterEach to remove the tmpdir.
 *
 * The returned ports are all unique within this env and extremely unlikely
 * to collide with any other concurrently-running test because the kernel
 * picks them for us.
 */
export async function createTestEnv(opts: CreateTestEnvOpts = {}): Promise<TestEnv> {
  const prefix = opts.arkDirPrefix ?? "ark-test-";
  const arkDir = await mkdtemp(join(tmpdir(), prefix));
  const [conductor, arkd, server, web, ...extras] = await allocatePorts(4 + (opts.extraPorts ?? 0));

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await rm(arkDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  };

  const env: TestEnv = {
    arkDir,
    ports: { conductor, arkd, server, web },
    cleanup,
  };
  // Expose extra ports on the env object without breaking the typed shape.
  // (Most tests don't need extras; those that do can cast.)
  if (extras.length > 0) {
    (env as TestEnv & { extraPorts: number[] }).extraPorts = extras;
  }
  return env;
}

// ── Combined AppContext + env ──────────────────────────────────────────────

export interface CreateTestAppOpts extends CreateTestEnvOpts {
  /** Additional ArkConfig overrides (merged into AppContext.forTest). */
  config?: Partial<ArkConfig>;
}

/**
 * Build an AppContext wired to a fresh TestEnv. Ports in the app config
 * point at the env's allocated ports, so if the caller boots the conductor
 * or arkd through app.boot() they won't collide with other parallel tests.
 *
 * Note: `AppContext.forTest()` sets `skipConductor/skipMetrics/skipSignals`
 * to `true` by default, so boot() will not actually bind the conductor port
 * unless the caller overrides those. The port values are still present in
 * config.conductorPort / config.arkdPort so tests that call startConductor()
 * or startArkd() directly can read them from there.
 */
export async function createTestApp(opts: CreateTestAppOpts = {}): Promise<{ app: AppContext; env: TestEnv }> {
  const env = await createTestEnv(opts);
  const app = AppContext.forTest({
    arkDir: env.arkDir,
    conductorPort: env.ports.conductor,
    arkdPort: env.ports.arkd,
    ...opts.config,
  });
  return { app, env };
}
