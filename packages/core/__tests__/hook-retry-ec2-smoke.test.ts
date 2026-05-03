/**
 * Smoke test: on_failure hook-driven retry over EC2-backed sessions.
 *
 * Context: in May 2026 commit `da93cb2b` (requires_repo gate) the newline
 * between `requires_repo: true` and `stages:` got eaten in every builtin
 * flow YAML (`requires_repo: truestages:`). YAML then failed to parse, the
 * file-backed FlowStore silently dropped the flow, and `getStage(flow,
 * stage)` came back undefined -- so `applyHookStatus` never saw an
 * `on_failure: retry(N)` directive and the hook-retry path never fired.
 *
 * The conductor retry path is itself compute-agnostic: hooks from EC2
 * arkd tunnel to the same `/hooks/status` route as local hooks, the
 * applier reads the same flow definition, and `retryWithContext` +
 * background dispatch run against the same session row. There is no
 * EC2-specific branch in that pipeline.
 *
 * This test locks that invariant in by pinning the session's compute to
 * an EC2 row (compute_kind='ec2', via both legacy provider='ec2' and the
 * explicit compute='ec2' axis) and asserting that a `StopFailure` hook
 * POSTed to the conductor still:
 *   1. Logs a `retry_with_context` event, and
 *   2. Leaves the session in ready/running (not failed),
 *
 * mirroring the local-compute assertions in `on-failure-retry.test.ts`.
 * If a future refactor gates hook retry on compute_kind, or re-breaks a
 * flow YAML so `getStage` loses the `on_failure` directive, this test
 * turns red.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startConductor } from "../conductor/conductor.js";
import { withTestContext, getApp, waitFor } from "./test-helpers.js";
import { allocatePort } from "../config/port-allocator.js";

const { getCtx: _getCtx } = withTestContext();
void _getCtx;

describe("hook flow retry on EC2 (smoke)", () => {
  let server: { stop(): void };
  let port: number;

  beforeEach(async () => {
    port = await allocatePort();
    server = startConductor(getApp(), port, { quiet: true });
  });

  afterEach(() => {
    try {
      server.stop();
    } catch {
      /* cleanup */
    }
  });

  async function postHook(sessionId: string, payload: Record<string, unknown>): Promise<Response> {
    return fetch(`http://localhost:${port}/hooks/status?session=${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("hook StopFailure on EC2 session triggers on_failure retry", async () => {
    const app = getApp();

    // Seed an EC2 compute row. Write both the legacy `provider` axis and
    // the new `compute` axis explicitly so the dual-write schema lands a
    // row whose compute_kind is unambiguously 'ec2'.
    await app.computeService.create({
      name: "ec2-prod",
      provider: "ec2" as any,
      compute: "ec2" as any,
      config: {},
    });

    const session = await app.sessions.create({
      summary: "ec2 hook-retry smoke",
      flow: "quick",
    });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      compute_name: "ec2-prod",
    });

    const resp = await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "Remote agent crashed",
    });
    expect(resp.status).toBe(200);

    // retryWithContext resets the session to `ready` and kicks a background
    // dispatch. Under the test profile the noop executor promotes status
    // back to `running` before this assertion fires, so accept either --
    // the retry_with_context event is the authoritative signal.
    await waitFor(async () => {
      const updated = await app.sessions.get(session.id);
      return updated != null && (updated.status === "ready" || updated.status === "running");
    });
    const updated = await app.sessions.get(session.id)!;
    expect(["ready", "running"]).toContain(updated.status);

    const events = await app.events.list(session.id);
    const retryEvent = events.find((e) => e.type === "retry_with_context");
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.data!.attempt).toBe(1);
  });

  it("hook StopFailure on EC2 session exhausts retries and stays failed", async () => {
    const app = getApp();
    await app.computeService.create({
      name: "ec2-exhaust",
      provider: "ec2" as any,
      compute: "ec2" as any,
      config: {},
    });

    const session = await app.sessions.create({
      summary: "ec2 hook-retry exhausted smoke",
      flow: "quick",
    });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "implement",
      compute_name: "ec2-exhaust",
    });

    // Quick flow's implement stage has on_failure: retry(3). Simulate the
    // three retries having already happened so the next StopFailure falls
    // through to terminal failure rather than kicking another retry.
    for (let i = 0; i < 3; i++) {
      await app.events.log(session.id, "retry_with_context", {
        actor: "system",
        data: { attempt: i + 1 },
      });
    }

    const resp = await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "Still failing on EC2",
    });
    expect(resp.status).toBe(200);

    const updated = await app.sessions.get(session.id)!;
    expect(updated.status).toBe("failed");
  });
});
