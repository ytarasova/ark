/**
 * Tests for the on_failure retry loop wiring.
 *
 * Validates:
 * 1. parseOnFailure correctly parses "retry(N)" directives
 * 2. applyReport with type=error on a stage with on_failure: "retry(N)" sets shouldRetry
 * 3. applyReport with type=error on a stage WITHOUT on_failure does NOT set shouldRetry
 * 4. applyHookStatus with StopFailure on a retry stage sets shouldRetry
 * 5. Conductor integration: retry loop calls retryWithContext and re-dispatches
 * 6. Conductor integration: max retries exhausted falls through to failed
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseOnFailure } from "../services/session-hooks/index.js";
import { startConductor } from "./_util/start-test-server.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

const { getCtx } = withTestContext();

// ── parseOnFailure ──────────────────────────────────────────────────────────

describe("parseOnFailure", () => {
  it("parses retry(3) correctly", () => {
    const result = parseOnFailure("retry(3)");
    expect(result).toEqual({ retry: true, maxRetries: 3 });
  });

  it("parses retry(1) correctly", () => {
    const result = parseOnFailure("retry(1)");
    expect(result).toEqual({ retry: true, maxRetries: 1 });
  });

  it("returns null for notify", () => {
    expect(parseOnFailure("notify")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseOnFailure(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseOnFailure("")).toBeNull();
  });

  it("returns null for malformed retry", () => {
    expect(parseOnFailure("retry(abc)")).toBeNull();
    expect(parseOnFailure("retry()")).toBeNull();
    expect(parseOnFailure("retry")).toBeNull();
  });
});

// ── applyReport on_failure retry ────────────────────────────────────────────

describe("applyReport error with on_failure retry", async () => {
  it("sets shouldRetry when stage has on_failure: retry(N)", async () => {
    const app = getApp();
    // quick flow has implement stage with on_failure: "retry(3)"
    const session = await app.sessions.create({ summary: "retry test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    const result = await app.sessionHooks.applyReport(session.id, {
      type: "error",
      stage: "implement",
      error: "Tests failed",
    } as any);

    expect(result.updates.status).toBe("failed");
    expect(result.updates.error).toBe("Tests failed");
    expect(result.shouldRetry).toBe(true);
    expect(result.retryMaxRetries).toBe(3);
  });

  it("does NOT set shouldRetry when stage has no on_failure", async () => {
    const app = getApp();
    // quick flow's verify stage has no on_failure
    const session = await app.sessions.create({ summary: "no retry test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "verify" });

    const result = await app.sessionHooks.applyReport(session.id, {
      type: "error",
      stage: "verify",
      error: "Verify failed",
    } as any);

    expect(result.updates.status).toBe("failed");
    expect(result.shouldRetry).toBeFalsy();
    expect(result.retryMaxRetries).toBeUndefined();
  });

  it("does NOT set shouldRetry when on_failure is notify", async () => {
    const app = getApp();
    // bare flow has no on_failure at all, but let's test with a session that has no flow
    const session = await app.sessions.create({ summary: "bare test", flow: "bare" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "work" });

    const result = await app.sessionHooks.applyReport(session.id, {
      type: "error",
      stage: "work",
      error: "Something broke",
    } as any);

    expect(result.updates.status).toBe("failed");
    expect(result.shouldRetry).toBeFalsy();
  });

  it("does NOT set shouldRetry for non-error reports", async () => {
    const app = getApp();
    const session = await app.sessions.create({ summary: "progress test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    const result = await app.sessionHooks.applyReport(session.id, {
      type: "progress",
      stage: "implement",
      message: "Working on it",
    } as any);

    expect(result.shouldRetry).toBeFalsy();
  });
});

// ── applyHookStatus on_failure retry ────────────────────────────────────────

describe("applyHookStatus failure with on_failure retry", async () => {
  it("sets shouldRetry on StopFailure when stage has on_failure: retry(N)", async () => {
    const app = getApp();
    const session = await app.sessions.create({ summary: "hook retry test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });
    const fresh = await app.sessions.get(session.id)!;

    const result = await app.sessionHooks.applyHookStatus(fresh, "StopFailure", {
      error: "Agent crashed",
    });

    expect(result.newStatus).toBe("failed");
    expect(result.shouldRetry).toBe(true);
    expect(result.retryMaxRetries).toBe(3);
  });

  it("does NOT set shouldRetry on StopFailure when stage has no on_failure", async () => {
    const app = getApp();
    const session = await app.sessions.create({ summary: "hook no-retry test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "verify" });
    const fresh = await app.sessions.get(session.id)!;

    const result = await app.sessionHooks.applyHookStatus(fresh, "StopFailure", {
      error: "Agent crashed",
    });

    expect(result.newStatus).toBe("failed");
    expect(result.shouldRetry).toBeFalsy();
  });

  it("does NOT set shouldRetry on SessionStart (not a failure)", async () => {
    const app = getApp();
    const session = await app.sessions.create({ summary: "start test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });
    const fresh = await app.sessions.get(session.id)!;

    const result = await app.sessionHooks.applyHookStatus(fresh, "SessionStart", {});

    expect(result.newStatus).toBe("running");
    expect(result.shouldRetry).toBeFalsy();
  });
});

// ── Conductor integration: retry loop ───────────────────────────────────────

const TEST_PORT = 19198;

describe("conductor on_failure retry loop", async () => {
  let server: { stop(): void };

  beforeEach(() => {
    server = startConductor(getApp(), TEST_PORT, { quiet: true });
  });

  afterEach(() => {
    try {
      server.stop();
    } catch {
      /* cleanup */
    }
  });

  async function postReport(sessionId: string, report: Record<string, unknown>): Promise<Response> {
    return fetch(`http://localhost:${TEST_PORT}/api/channel/${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  }

  async function postHook(sessionId: string, payload: Record<string, unknown>): Promise<Response> {
    return fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  it("error report on retry stage resets to ready and logs retry event", async () => {
    const app = getApp();
    const session = await app.sessions.create({ summary: "conductor retry test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    const resp = await postReport(session.id, {
      type: "error",
      error: "Build failed",
      stage: "implement",
    });
    expect(resp.status).toBe(200);

    // retryWithContext resets to `ready` and background-dispatches; under
    // the test profile the noop executor completes that dispatch fast
    // enough to flip status to `running` before we observe. Either state
    // is acceptable -- the `retry_with_context` event is the authoritative
    // signal that the retry path ran.
    const updated = await app.sessions.get(session.id)!;
    expect(["ready", "running"]).toContain(updated.status);
    expect(updated.error).toBeNull();

    // Should have logged a retry event
    const events = await app.events.list(session.id);
    const retryEvent = events.find((e) => e.type === "retry_with_context");
    expect(retryEvent).toBeDefined();
    expect(retryEvent!.data!.attempt).toBe(1);
    expect(retryEvent!.data!.error).toBe("Build failed");
  });

  it("error report falls through to failed when max retries exhausted", async () => {
    const app = getApp();
    const session = await app.sessions.create({ summary: "exhausted retry test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    // Simulate 3 prior retries (quick flow has retry(3))
    for (let i = 0; i < 3; i++) {
      await app.events.log(session.id, "retry_with_context", {
        actor: "system",
        data: { attempt: i + 1 },
      });
    }

    const resp = await postReport(session.id, {
      type: "error",
      error: "Still failing",
      stage: "implement",
    });
    expect(resp.status).toBe(200);

    // Should remain failed -- retries exhausted
    const updated = await app.sessions.get(session.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("Still failing");
  });

  it("error report on non-retry stage stays failed", async () => {
    const app = getApp();
    const session = await app.sessions.create({ summary: "no-retry test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "verify" });

    const resp = await postReport(session.id, {
      type: "error",
      error: "Verification failed",
      stage: "verify",
    });
    expect(resp.status).toBe(200);

    const updated = await app.sessions.get(session.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.error).toBe("Verification failed");

    // No retry event should be logged
    const events = await app.events.list(session.id);
    const retryEvent = events.find((e) => e.type === "retry_with_context");
    expect(retryEvent).toBeUndefined();
  });

  it("hook StopFailure on retry stage resets to ready", async () => {
    const app = getApp();
    const session = await app.sessions.create({ summary: "hook retry test", flow: "quick" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running", stage: "implement" });

    const resp = await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "Agent crashed",
    });
    expect(resp.status).toBe(200);

    // retryWithContext resets status to `ready` and kicks the dispatcher
    // in the background; under the test profile that dispatch runs through
    // the noop executor and promotes status back to `running` before this
    // assertion fires. Accept either -- the `retry_with_context` event is
    // the authoritative signal that the retry path actually ran.
    const updated = await app.sessions.get(session.id)!;
    expect(["ready", "running"]).toContain(updated.status);

    // Should have logged a retry event
    const events = await app.events.list(session.id);
    const retryEvent = events.find((e) => e.type === "retry_with_context");
    expect(retryEvent).toBeDefined();
  });
});
