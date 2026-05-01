/**
 * Unit tests for SessionDispatchListeners' dispatch-level watchdog.
 *
 * Pass-5 silent-failure remediation: a live EC2 dispatch hung at status=ready
 * for 7+ minutes because the underlying fetch had no enforced timeout. The
 * arkd-client fix closes that specific door, but a future code path could
 * re-introduce a hang outside the client (poll loop, subprocess, etc.). The
 * watchdog races the dispatch promise against a deadline and force-fails the
 * session if it expires.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { AppContext } from "../app.js";
import { SessionDispatchListeners } from "../services/session-dispatch-listeners.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("SessionDispatchListeners watchdog", () => {
  it("force-fails the session when dispatch hangs past the watchdog deadline", async () => {
    const session = await app.sessions.create({ summary: "watchdog hang test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    // Dispatch returns a never-resolving promise -- mirrors the live hang
    // shape (fetch against unreachable URL with no client-side timeout).
    let dispatchInvoked = false;
    const neverResolves = new Promise<{ ok: boolean; message?: string }>(() => {});
    const listeners = new SessionDispatchListeners(
      app.sessions,
      app.events,
      async () => {
        dispatchInvoked = true;
        return neverResolves;
      },
      { dispatchWatchdogMs: 250 },
    );

    let onDispatchedFired = false;
    const unregister = listeners.registerDefaultDispatcher(() => {
      onDispatchedFired = true;
    });
    try {
      const t0 = Date.now();
      listeners.emit(session.id);
      await listeners.drain();
      const elapsed = Date.now() - t0;

      expect(dispatchInvoked).toBe(true);
      // drain() returns once the watchdog fires + the failure-marking
      // chain finishes. With a 250ms watchdog we expect drain to settle
      // well under 2s.
      expect(elapsed).toBeLessThan(2000);
      expect(onDispatchedFired).toBe(true);
    } finally {
      unregister();
    }

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error?.toLowerCase()).toContain("hung");
    expect(updated?.error).toContain("250");

    const events = await app.events.list(session.id);
    const failed = events.find((e) => e.type === "dispatch_failed");
    expect(failed).toBeTruthy();
    const reason = String(failed!.data?.reason ?? "");
    expect(reason.toLowerCase()).toContain("hung");
  });

  it("does NOT force-fail when dispatch resolves before the deadline", async () => {
    const session = await app.sessions.create({ summary: "watchdog non-hang test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    const listeners = new SessionDispatchListeners(
      app.sessions,
      app.events,
      async (id) => {
        // Real launch shape: flip to running, return ok:true.
        await app.sessions.update(id, { status: "running" });
        return { ok: true, message: "launched" };
      },
      { dispatchWatchdogMs: 1000 },
    );

    const unregister = listeners.registerDefaultDispatcher(() => {});
    try {
      listeners.emit(session.id);
      await listeners.drain();
    } finally {
      unregister();
    }

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("running");
    const events = await app.events.list(session.id);
    expect(events.find((e) => e.type === "dispatch_failed")).toBeFalsy();
  });
});
