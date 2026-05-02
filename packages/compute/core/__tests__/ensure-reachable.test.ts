/**
 * Compute.ensureReachable tests.
 *
 * The interface method is optional; here we verify the LocalCompute no-op
 * shape the dispatcher relies on. Provider-specific tests for EC2/K8s/
 * Firecracker live alongside their existing test files (ec2-compute.test.ts,
 * k8s-compute.test.ts, firecracker-compute.test.ts) so the helper-injection
 * fixtures are reused.
 */

import { describe, expect, test } from "bun:test";
import { LocalCompute } from "../local.js";

describe("Compute.ensureReachable", () => {
  test("LocalCompute is a no-op (always reachable)", async () => {
    const c = new LocalCompute({} as never);
    if (c.ensureReachable) {
      await c.ensureReachable({ kind: "local", name: "local", meta: {} }, { app: {} as never, sessionId: "s-test" });
    }
    // No throw, no side effects.
    expect(true).toBe(true);
  });
});
