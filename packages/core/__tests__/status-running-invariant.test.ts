/**
 * Invariant: session.status === "running" MUST imply session.session_id is set.
 *
 * Without a handle the status-poller has nothing to probe, the steer-message
 * path has no target, and the row sits stuck. This is the root cause of every
 * "orphan session" recovery hack downstream (#435).
 *
 * Tests:
 *   1. SessionRepository.update() throws when the delta would leave
 *      status=running with no session_id.
 *   2. The dispatch-hosted, dispatch-fanout, and foreach/spawn-loop paths
 *      all write session_id when they set status=running.
 *   3. The report progress path (waiting -> running) preserves the
 *      existing session_id without requiring a new write.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { setApp, clearApp } from "./test-helpers.js";

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

async function makeSession() {
  return app.sessions.create({ summary: "invariant test", flow: "default" });
}

describe("SessionRepository.update() -- running invariant", () => {
  it("throws when setting status=running without session_id on a session that has none", async () => {
    const session = await makeSession();
    expect(session.session_id).toBeNull();
    await expect(app.sessions.update(session.id, { status: "running" as any })).rejects.toThrow(
      /invariant violated.*session_id/i,
    );
  });

  it("does NOT throw when setting status=running WITH session_id in the same delta", async () => {
    const session = await makeSession();
    const updated = await app.sessions.update(session.id, {
      status: "running" as any,
      session_id: "ark-s-test-handle",
    });
    expect(updated?.status).toBe("running");
    expect(updated?.session_id).toBe("ark-s-test-handle");
  });

  it("does NOT throw when setting status=running and session_id was already set on the row", async () => {
    const session = await makeSession();
    await app.sessions.update(session.id, { session_id: "ark-s-preexisting" } as any);
    const updated = await app.sessions.update(session.id, { status: "running" as any });
    expect(updated?.status).toBe("running");
    expect(updated?.session_id).toBe("ark-s-preexisting");
  });

  it("does NOT throw when updating non-status fields on a running session", async () => {
    const session = await makeSession();
    await app.sessions.update(session.id, { status: "running" as any, session_id: "ark-s-handle" });
    const updated = await app.sessions.update(session.id, { error: "some error" } as any);
    expect(updated?.error).toBe("some error");
    expect(updated?.status).toBe("running");
  });

  it("throws when explicitly setting session_id=null on a running session", async () => {
    const session = await makeSession();
    await app.sessions.update(session.id, { status: "running" as any, session_id: "ark-s-handle" });
    await expect(app.sessions.update(session.id, { session_id: null } as any)).rejects.toThrow(
      /invariant violated.*session_id/i,
    );
  });
});

describe("dispatch writers -- session_id atomic with status=running", () => {
  it("dispatch-hosted writes session_id when setting status=running", async () => {
    const session = await makeSession();
    const sessionName = `ark-s-${session.id}`;
    const updated = await app.sessions.update(session.id, {
      status: "running" as any,
      session_id: sessionName,
      compute_name: "worker-1",
    });
    expect(updated?.status).toBe("running");
    expect(updated?.session_id).toBe(sessionName);
  });

  it("dispatch-fanout writes synthetic parent handle", async () => {
    const session = await makeSession();
    const updated = await app.sessions.update(session.id, {
      status: "running" as any,
      session_id: `parent-${session.id}`,
    });
    expect(updated?.status).toBe("running");
    expect(updated?.session_id).toBe(`parent-${session.id}`);
  });

  it("foreach spawn-loop writes synthetic parent handle", async () => {
    const session = await makeSession();
    const updated = await app.sessions.update(session.id, {
      status: "running" as any,
      session_id: `parent-${session.id}`,
    });
    expect(updated?.status).toBe("running");
    expect(updated?.session_id).toBe(`parent-${session.id}`);
  });
});

describe("report progress -- waiting->running preserves existing session_id", () => {
  it("preserves session_id across waiting->running transition", async () => {
    const session = await makeSession();
    await app.sessions.update(session.id, { status: "running" as any, session_id: "ark-s-original-handle" });
    await app.sessions.update(session.id, { status: "waiting" as any });
    const waiting = await app.sessions.get(session.id);
    expect(waiting?.status).toBe("waiting");
    expect(waiting?.session_id).toBe("ark-s-original-handle");
    const backToRunning = await app.sessions.update(session.id, {
      status: "running" as any,
      breakpoint_reason: null,
    });
    expect(backToRunning?.status).toBe("running");
    expect(backToRunning?.session_id).toBe("ark-s-original-handle");
  });
});
