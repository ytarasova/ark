/**
 * FirecrackerCompute end-to-end test.
 *
 * This test boots a REAL Firecracker microVM and talks to the arkd instance
 * running inside it. It is the "big hammer" that catches regressions the
 * unit tests can't: real kernel boot, real networking, real arkd binding.
 *
 * Skipped by default. Runs only when all of these are true:
 *   - process.platform === "linux"
 *   - /dev/kvm is readable + writable by the current user
 *   - ARK_E2E_FIRECRACKER=1 in the environment (explicit opt-in)
 *
 * Rationale for the opt-in env var: the test downloads ~300 MiB of kernel
 * + rootfs on first run and takes ~30-60s to boot. We don't want it on the
 * default `make test` path. Run it locally with:
 *
 *   ARK_E2E_FIRECRACKER=1 make test-file \
 *     F=packages/compute/__tests__/firecracker-compute-e2e.test.ts
 *
 * or in CI with a dedicated `firecracker-e2e` job that runs on a bare-metal
 * Linux runner.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { accessSync, constants as fsConstants } from "fs";

import { FirecrackerCompute } from "../core/firecracker/compute.js";
import type { FirecrackerMeta } from "../core/firecracker/compute.js";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

/**
 * Decide whether the e2e test should run. Non-throwing: on any check that
 * fails we return false + a reason so the describe.skipIf block can short-
 * circuit with a readable log message.
 */
function canRunE2e(): { run: boolean; reason: string } {
  if (process.env.ARK_E2E_FIRECRACKER !== "1") {
    return { run: false, reason: "ARK_E2E_FIRECRACKER != 1" };
  }
  if (process.platform !== "linux") {
    return { run: false, reason: `platform=${process.platform}` };
  }
  try {
    accessSync("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    return { run: false, reason: "/dev/kvm not accessible" };
  }
  return { run: true, reason: "ok" };
}

const { run, reason } = canRunE2e();

describe.skipIf(!run)(`FirecrackerCompute e2e (${reason})`, async () => {
  it("boots a real microVM, reaches arkd /snapshot from the host, destroys", async () => {
    const compute = new FirecrackerCompute(app);
    const logs: string[] = [];
    const handle = await compute.provision({
      tags: { name: `e2e-${Date.now()}` },
      onLog: (m) => logs.push(m),
    });

    try {
      const meta = (handle.meta as { firecracker: FirecrackerMeta }).firecracker;
      expect(meta.vmId).toMatch(/^ark-fc-/);
      expect(meta.arkdUrl).toMatch(/^http:\/\/192\.168\.127\.\d+:19300$/);

      // The /snapshot endpoint is arkd's canonical health signal. A 2xx or
      // even a 4xx means arkd is listening. 5xx or network errors mean
      // something's wrong in the guest.
      const res = await fetch(`${meta.arkdUrl}/snapshot`);
      expect(res.status).toBeLessThan(500);

      expect(compute.getArkdUrl(handle)).toBe(meta.arkdUrl);
    } finally {
      await compute.destroy(handle);
    }
  }, 180_000); // Big deadline: download + boot can take a minute on a cold cache.
});
