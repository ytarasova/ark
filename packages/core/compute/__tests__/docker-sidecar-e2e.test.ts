/**
 * Docker arkd-sidecar e2e test.
 *
 * Exercises the full provision -> arkd-inside-container -> destroy lifecycle
 * against a real Docker daemon. Gated on `ARK_E2E_DOCKER=1` because:
 *
 *   - A cold `ubuntu:22.04` bootstrap (apt update + tmux + bun + claude)
 *     takes 2-5 min on a slow network. Too slow for every CI run.
 *   - The test writes to /var/log inside the container and mounts the host
 *     repo as /opt/ark, which requires Docker Desktop file-sharing perms.
 *
 * Run locally with:   ARK_E2E_DOCKER=1 make test-file F=packages/compute/__tests__/docker-sidecar-e2e.test.ts
 *
 * Plumbing verified:
 *   1. Compute provision cleanly pulls, creates, bootstraps, and starts arkd.
 *   2. arkd in container is reachable from host via the loopback-mapped port.
 *   3. arkd responds to a real RPC (`/snapshot`) with the container's view.
 *   4. Destroy cleans up both DB row and container.
 *
 * Claude runtime is NOT exercised here (no agent actually runs). A separate
 * opt-in test (`ARK_E2E_CLAUDE=1`) covers the full agent-run path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { execFile } from "child_process";
import { promisify } from "util";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { LocalDockerProvider } from "../providers/local-arkd.js";

const execFileAsync = promisify(execFile);

const GATED = process.env.ARK_E2E_DOCKER === "1";

async function dockerAvailable(): Promise<boolean> {
  if (!GATED) return false;
  try {
    await execFileAsync("docker", ["info"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// The compute name includes a PID suffix so parallel runs of this test don't
// collide on `ark-docker-sidecar-e2e` (the docker provider derives container
// names from the compute name).
const COMPUTE_NAME = `docker-sidecar-e2e-${process.pid}`;

describe("Docker arkd-sidecar e2e", async () => {
  let app: AppContext;
  let available = false;

  beforeAll(async () => {
    available = await dockerAvailable();
    if (!available) return;

    app = await AppContext.forTestAsync();
    await app.boot();
    setApp(app);
  });

  afterAll(async () => {
    if (!available) return;

    // Best-effort cleanup of the container regardless of test outcome.
    (await execFileAsync("docker", ["rm", "-f", `ark-${COMPUTE_NAME}`])).catch(() => {});

    await app?.shutdown();
    clearApp();
  });

  it.skipIf(!GATED)(
    "provisions a container, starts arkd sidecar, verifies health, destroys",
    async () => {
      const provider = new LocalDockerProvider(app);

      await app.computeService.create({ name: COMPUTE_NAME, provider: "docker" });
      let compute = await app.computes.get(COMPUTE_NAME)!;
      expect(compute.status).toBe("stopped");

      // ── Provision (pull + create + bootstrap + start arkd) ────────────────
      await provider.provision(compute);
      compute = await app.computes.get(COMPUTE_NAME)!;
      expect(compute.status).toBe("running");

      const cfg = compute.config as Record<string, unknown>;
      const hostPort = cfg.arkd_host_port as number;
      expect(typeof hostPort).toBe("number");
      expect(hostPort).toBeGreaterThan(0);

      // ── Health check: arkd reachable from host via mapped port ────────────
      const res = await fetch(`http://localhost:${hostPort}/snapshot`);
      expect(res.ok).toBe(true);
      const snap = (await res.json()) as {
        metrics?: { memTotalGb: number; uptime: string };
        sessions?: unknown[];
        processes?: unknown[];
        docker?: unknown[];
      };
      // Snapshot has the shape arkd exposes -- prove we are talking to arkd
      // (not some unrelated service that happens to 200 on /snapshot).
      expect(snap.metrics).toBeTruthy();
      expect(typeof snap.metrics?.memTotalGb).toBe("number");
      expect(Array.isArray(snap.sessions)).toBe(true);
      expect(Array.isArray(snap.processes)).toBe(true);

      // ── Functional probe: arkd's file ops read the container's FS ─────────
      const fileRes = await fetch(`http://localhost:${hostPort}/file/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "/etc/os-release" }),
      });
      expect(fileRes.ok).toBe(true);
      const fileData = (await fileRes.json()) as { content: string };
      // ubuntu:22.04 identifies itself unambiguously.
      expect(fileData.content.toLowerCase()).toMatch(/ubuntu|debian|alpine|centos|fedora/);

      // ── Destroy (rm container + cascade DB) ───────────────────────────────
      await provider.destroy(compute);
      compute = await app.computes.get(COMPUTE_NAME)!;
      expect(compute.status).toBe("destroyed");

      // Container should be gone on the host side.
      const psRes = await execFileAsync("docker", [
        "ps",
        "-a",
        "--filter",
        `name=ark-${COMPUTE_NAME}`,
        "--format",
        "{{.Names}}",
      ]);
      expect(psRes.stdout.trim()).toBe("");
    },
    600_000,
  );
});
