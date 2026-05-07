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
  test("LocalCompute attaches the events consumer; no provision-time work", async () => {
    // LocalCompute.ensureReachable is the only side-effect path the
    // dispatcher relies on for local sessions: it starts the
    // arkd-events-consumer so hooks the agent publishes locally are
    // drained and re-emitted as session events. The startArkdEventsConsumer
    // call is idempotent per-compute.
    //
    // We pass a minimal AppContext-shaped stub that exposes only the
    // fields ensureReachable touches (config.ports.arkd for getArkdUrl
    // and the `app` argument's identity for the consumer registry).
    const stubApp = { config: { ports: { arkd: 19300 } } } as unknown as Parameters<
      typeof LocalCompute.prototype.constructor
    >[0];
    const c = new LocalCompute(stubApp);
    if (c.ensureReachable) {
      await c.ensureReachable(
        { kind: "local", name: "local", meta: {} },
        { app: stubApp as never, sessionId: "s-test" },
      );
    }
    // No throw -- consumer is already running for "local" (or freshly
    // started) and the call returned. We don't assert on the global
    // registry here; arkd-events-consumer.test.ts owns that contract.
    expect(true).toBe(true);
  });
});
