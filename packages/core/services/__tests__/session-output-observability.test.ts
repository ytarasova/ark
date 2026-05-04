/**
 * Observability tests for user-input send path.
 *
 * Every call to `sessionService.send(id, message)` MUST emit a paired
 * outcome event so the Events timeline / ark.jsonl can distinguish:
 *
 *   - `message_sent`              -- the audit row (pre-delivery, always fires)
 *   - `message_delivered`         -- executor returned ok=true; includes the
 *                                    `delivered` flag from the transport
 *                                    (wire runtimes only; undefined for tmux)
 *   - `message_delivery_failed`   -- executor returned ok=false OR threw
 *
 * Before this pairing landed, a dropped steer looked identical to a delivered
 * one from the UI: the timeline showed `message_sent` and nothing else. Now
 * the user (and debugging humans) see whether the message actually reached
 * the subscriber or got buffered on arkd's ring.
 *
 * These tests use the executor registry directly with stub executors so they
 * don't need real arkd / tmux / claude-code running -- the unit under test is
 * the `send()` function in `services/session-output.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";
import { registerExecutor, resetExecutors } from "../../executor.js";
import type { Executor, SendUserMessageOpts, SendUserMessageResult } from "../../executor.js";
import type { Session, SessionStatus } from "../../../types/index.js";

let app: AppContext;

// Build a stub executor we can swap per-test. `sendFn` controls the outcome.
function stubExecutor(name: string, sendFn: (opts: SendUserMessageOpts) => Promise<SendUserMessageResult>): Executor {
  return {
    name,
    launch: async () => ({ ok: true, handle: "h-1" }),
    kill: async () => {},
    status: async () => ({ state: "not_found" }),
    send: async () => {},
    capture: async () => "",
    sendUserMessage: sendFn,
  };
}

// Prepare a session in a state where send() won't short-circuit on missing
// session_id -- we set session_id, stage, and a launch_executor override.
async function primeRunningSession(executorName: string): Promise<string> {
  const s = await app.sessionService.start({ summary: "observability test" });
  await app.sessions.update(s.id, {
    status: "running" as SessionStatus,
    session_id: `ark-${s.id}`,
    stage: "implement",
    config: { launch_executor: executorName },
  } as Partial<Session>);
  return s.id;
}

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterEach(async () => {
  resetExecutors();
  clearApp();
  await app?.shutdown();
});

describe("session.send observability", () => {
  it("emits message_sent + message_delivered with delivered=true on happy path", async () => {
    registerExecutor(stubExecutor("stub-wire", async () => ({ ok: true, message: "Delivered", delivered: true })));
    const sessionId = await primeRunningSession("stub-wire");

    const res = await app.sessionService.send(sessionId, "hey there");
    expect(res.ok).toBe(true);

    const sent = await app.events.list(sessionId, { type: "message_sent" });
    const delivered = await app.events.list(sessionId, { type: "message_delivered" });
    expect(sent.length).toBe(1);
    expect(delivered.length).toBe(1);
    expect((delivered[0].data as any)?.delivered).toBe(true);
    expect((delivered[0].data as any)?.executor).toBe("stub-wire");
    expect((delivered[0].data as any)?.length).toBe("hey there".length);
    expect(typeof (delivered[0].data as any)?.elapsedMs).toBe("number");
  });

  it("emits message_delivered with delivered=false when envelope was buffered", async () => {
    // Wire-level delivered=false -- no subscriber was parked, arkd buffered.
    // The send still returns ok=true but the event carries the queued bit so
    // the UI can label it differently (amber chip vs blue chip).
    registerExecutor(
      stubExecutor("stub-wire-buffered", async () => ({
        ok: true,
        message: "Queued (no subscriber parked)",
        delivered: false,
      })),
    );
    const sessionId = await primeRunningSession("stub-wire-buffered");

    const res = await app.sessionService.send(sessionId, "buffered message");
    expect(res.ok).toBe(true);

    const delivered = await app.events.list(sessionId, { type: "message_delivered" });
    expect(delivered.length).toBe(1);
    expect((delivered[0].data as any)?.delivered).toBe(false);
  });

  it("emits message_delivered with delivered=undefined for tmux-style runtimes", async () => {
    // Tmux runtimes (claude-code) don't populate `delivered` -- the concept
    // doesn't apply to send-keys. The event carries delivered=undefined so
    // the UI falls back to the default "delivered" treatment.
    registerExecutor(stubExecutor("stub-tmux", async () => ({ ok: true, message: "Delivered" })));
    const sessionId = await primeRunningSession("stub-tmux");

    const res = await app.sessionService.send(sessionId, "tmux send");
    expect(res.ok).toBe(true);

    const delivered = await app.events.list(sessionId, { type: "message_delivered" });
    expect(delivered.length).toBe(1);
    expect((delivered[0].data as any)?.delivered).toBeUndefined();
  });

  it("emits message_delivery_failed when the executor returns ok=false", async () => {
    registerExecutor(stubExecutor("stub-fail", async () => ({ ok: false, message: "arkd unreachable" })));
    const sessionId = await primeRunningSession("stub-fail");

    const res = await app.sessionService.send(sessionId, "this will fail");
    expect(res.ok).toBe(false);

    const failed = await app.events.list(sessionId, { type: "message_delivery_failed" });
    const delivered = await app.events.list(sessionId, { type: "message_delivered" });
    expect(failed.length).toBe(1);
    expect(delivered.length).toBe(0);
    expect((failed[0].data as any)?.reason).toBe("arkd unreachable");
    expect((failed[0].data as any)?.executor).toBe("stub-fail");
  });

  it("emits message_delivery_failed when the executor throws", async () => {
    registerExecutor(
      stubExecutor("stub-throw", async () => {
        throw new Error("connection refused");
      }),
    );
    const sessionId = await primeRunningSession("stub-throw");

    const res = await app.sessionService.send(sessionId, "this will throw");
    expect(res.ok).toBe(false);
    expect(res.message).toContain("connection refused");

    const failed = await app.events.list(sessionId, { type: "message_delivery_failed" });
    expect(failed.length).toBe(1);
    expect((failed[0].data as any)?.reason).toContain("connection refused");
  });

  it("message_delivered stage matches session.stage at send time", async () => {
    registerExecutor(stubExecutor("stub-stage", async () => ({ ok: true, message: "Delivered", delivered: true })));
    const sessionId = await primeRunningSession("stub-stage");

    await app.sessionService.send(sessionId, "stamp stage");
    const delivered = await app.events.list(sessionId, { type: "message_delivered" });
    expect(delivered.length).toBe(1);
    // `stage` lives on the Event row itself, not on data.
    expect(delivered[0].stage).toBe("implement");
  });
});
