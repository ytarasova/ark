/**
 * End-to-end test for control-plane (hosted) mode.
 *
 * Boots the real `ark server start --hosted` binary against an isolated
 * Docker compose stack (Postgres :15434 + Redis :6380), creates a session
 * via /api/rpc, and asserts it transitions to `completed` within a budget.
 *
 * Phase 1 -- uses the action-only `e2e-noop` flow. No agent runtime, no tmux,
 * no LLM. Catches:
 *   - migration runner against fresh Postgres (schema parity)
 *   - hosted DI wiring (forTenant memoization, dispatcher registration)
 *   - session_created event emission + dispatcher hookup
 *   - poller race / multi-tenant gap (status transitions)
 *   - the no-workers fall-through to local dispatch
 *
 * Phase 2 -- uses the `e2e-docs` flow (plan -> implement -> close) with a
 * stub agent. The stub agent (e2e/fixtures/stub-agent.sh) is launched as a
 * real subprocess via the `stub-runner` plugin executor, posts a canned
 * CompletionReport to the conductor's channel HTTP endpoint, and exits.
 * This exercises the full dispatch chain without an LLM:
 *   CoreDispatcher -> stub-runner executor -> Bun.spawn -> stub-agent.sh
 *   -> POST /api/channel/:id -> applyReport -> StageAdvancer -> next stage
 *
 * Note on tmux: the stub-runner executor uses Bun.spawn (not tmux) so no tmux
 * pane is created. This is intentional -- the goal is to prove the report-back
 * wire, not the tmux transport. The tmux path is exercised in the arkd-backed
 * compute tests.
 *
 * Usage: `make test-e2e-control-plane`. Requires Docker.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { up as composeUp, down as composeDown } from "./helpers/docker-stack.js";
import { spawnServer, killServer, type ServerHandle } from "./helpers/server-process.js";
import { RpcClient, waitFor } from "./helpers/rpc-client.js";

// Per-run isolated arkDir so blobs/snapshots written by hosted-mode storage
// land in a temp tree we can wipe at the end. Without this, artifacts from
// repeated runs accumulate in whatever ARK_DIR the test inherits.
let arkDir: string;
let server: ServerHandle;
let rpc: RpcClient;

const REPO_ROOT = resolve(import.meta.dir, "..");
const ENV_FILE = join(REPO_ROOT, ".env.e2e");

beforeAll(async () => {
  arkDir = mkdtempSync(join(tmpdir(), "ark-e2e-"));

  // Phase 2: install the stub-runner plugin executor into the temp arkDir
  // BEFORE the server boots so loadPluginExecutors discovers it at startup.
  const pluginDir = join(arkDir, "plugins", "executors");
  mkdirSync(pluginDir, { recursive: true });
  copyFileSync(join(REPO_ROOT, "e2e", "fixtures", "stub-runner-executor.mjs"), join(pluginDir, "stub-runner.mjs"));

  await composeUp();
  server = await spawnServer({ arkDir, envFile: ENV_FILE, startupTimeoutMs: 45_000 });
  rpc = new RpcClient(server.webUrl);

  // Hosted/control-plane mode does NOT auto-seed a `local` compute target
  // (production deploys manage compute targets via `ark compute create`).
  // The default SessionService.start() compute_name is `"local"`, so we
  // create that row here -- mirrors what an operator would do once after
  // boot. Idempotent on conflict.
  await rpc
    .call("compute/create", {
      name: "local",
      compute: "local",
      isolation: "direct",
    })
    .catch((err) => {
      // Ignore "already exists" so the test is rerun-safe even when the
      // stack is reused via ARK_E2E_STACK_RUNNING=1.
      if (!String(err?.message ?? "").toLowerCase().includes("exist")) throw err;
    });
}, 120_000);

afterAll(async () => {
  if (server) await killServer(server);
  await composeDown();
  if (arkDir) rmSync(arkDir, { recursive: true, force: true });
}, 60_000);

describe("control-plane e2e", () => {
  test("server health probe responds 200 with version", async () => {
    const r = await fetch(`${server.webUrl}/api/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; version: string; uptime: number };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });

  test("action-only flow (e2e-noop) reaches completed", async () => {
    // Create a session running the e2e-noop flow -- single auto-gate
    // action stage. This stage runs server-side (no agent), advances
    // immediately, and the session should land in `completed`.
    const startResult = (await rpc.call("session/start", {
      flow: "e2e-noop",
      summary: "e2e: action-only smoke",
    })) as { session: { id: string; status: string } };

    expect(startResult.session.id).toMatch(/^s-/);
    const sessionId = startResult.session.id;

    // Poll until terminal. The 30s budget is comfortably above the 10s
    // poller tick + the action's own latency; a real failure trips long
    // before this hits.
    let final: { session: { id: string; status: string; stage?: string; error?: string } };
    try {
      final = await waitFor(
        () =>
          rpc.call<{ session: { id: string; status: string; stage?: string; error?: string } }>("session/read", {
            sessionId,
            include: ["events"],
          }),
        (v) => ["completed", "failed", "stopped"].includes(v.session.status),
        { timeoutMs: 30_000, intervalMs: 500, description: `session ${sessionId} terminal status` },
      );
    } catch (err) {
      // Diagnostic: dump state + events before re-throwing so the failure
      // explains itself instead of just saying "timed out".
      const dump = await rpc.call("session/read", { sessionId, include: ["events"] }).catch(() => null);
      console.error("session never reached terminal state. final dump:", JSON.stringify(dump, null, 2));
      throw err;
    }

    if (final.session.status !== "completed") {
      const dump = await rpc.call("session/read", { sessionId, include: ["events"] }).catch(() => null);
      console.error("session reached terminal state but not 'completed'. dump:", JSON.stringify(dump, null, 2));
    }
    expect(final.session.status).toBe("completed");
  }, 60_000);

  test("docs flow with stub agent reaches completed through plan -> implement -> close", async () => {
    // Phase 2: multi-stage flow exercising the full dispatch chain without an
    // LLM. The stub-runner plugin executor launches e2e/fixtures/stub-agent.sh
    // as a Bun.spawn child process. The script reads ARK_SESSION_ID +
    // ARK_STAGE from env, posts a CompletionReport to the conductor's
    // /api/channel/:id HTTP endpoint, and exits 0. The conductor advances
    // each auto-gate stage until the final close_ticket action completes.
    //
    // Dispatch path exercised:
    //   session/start -> CoreDispatcher -> stub-runner executor -> Bun.spawn
    //   -> stub-agent.sh -> POST /api/channel/:id -> applyReport
    //   -> StageAdvancer.advance -> (plan) -> (implement) -> (close action)
    //   -> session.status = "completed"
    //
    // Note: no tmux pane is created (stub-runner uses Bun.spawn directly).
    const startResult = await rpc.call<{ session: { id: string; status: string } }>("session/start", {
      flow: "e2e-docs",
      summary: "Implement function to get_cpu_usage",
    });

    expect(startResult.session.id).toMatch(/^s-/);
    const sessionId = startResult.session.id;

    let final: { session: { id: string; status: string; stage?: string; error?: string } };
    try {
      final = await waitFor(
        () =>
          rpc.call<{ session: { id: string; status: string; stage?: string; error?: string } }>("session/read", {
            sessionId,
            include: ["events"],
          }),
        (v) => ["completed", "failed", "stopped"].includes(v.session.status),
        { timeoutMs: 60_000, intervalMs: 500, description: `e2e-docs session ${sessionId} terminal status` },
      );
    } catch (err) {
      const dump = await rpc.call("session/read", { sessionId, include: ["events"] }).catch(() => null);
      console.error("e2e-docs session never reached terminal state. final dump:", JSON.stringify(dump, null, 2));
      throw err;
    }

    if (final.session.status !== "completed") {
      const dump = await rpc.call("session/read", { sessionId, include: ["events"] }).catch(() => null);
      console.error("e2e-docs session reached terminal but not 'completed'. dump:", JSON.stringify(dump, null, 2));
    }
    expect(final.session.status).toBe("completed");
  }, 90_000);
});
