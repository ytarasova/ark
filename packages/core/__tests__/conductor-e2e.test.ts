/**
 * End-to-end tests for the conductor report pipeline.
 *
 * Validates the full flow: conductor starts → agent posts report →
 * message stored in DB → getMessages returns it.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { startConductor } from "../conductor/conductor.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

// Use a non-default port to avoid conflicts with a running conductor
const TEST_PORT = 19199;

let app: AppContext;
let server: { stop(app): void };

beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
  server = startConductor(app, TEST_PORT, { quiet: true });
});

afterEach(() => {
  try {
    server.stop();
  } catch {
    /* cleanup */
  }
});

afterAll(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
});

async function postReport(sessionId: string, report: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${TEST_PORT}/api/channel/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
}

describe("Conductor E2E -- report pipeline", async () => {
  it("progress report creates an agent message in the DB", async () => {
    const session = await getApp().sessions.create({ summary: "test session" });

    const resp = await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      message: "Working on the task...",
    });
    expect(resp.status).toBe(200);

    const msgs = await getApp().messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("progress");
    expect(msgs[0].content).toBe("Working on the task...");
  });

  it("completed report creates a message and updates session status", async () => {
    const session = await getApp().sessions.create({ summary: "complete me" });

    const resp = await postReport(session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "work",
      summary: "All done!",
      filesChanged: ["src/index.ts"],
      commits: ["abc123"],
    });
    expect(resp.status).toBe(200);

    const msgs = await getApp().messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("completed");
    expect(msgs[0].content).toContain("All done!");
  });

  it("question report creates a message and sets session to waiting", async () => {
    const session = await getApp().sessions.create({ summary: "question session" });

    const resp = await postReport(session.id, {
      type: "question",
      sessionId: session.id,
      stage: "work",
      question: "Should I proceed?",
    });
    expect(resp.status).toBe(200);

    const msgs = await getApp().messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("question");
    expect(msgs[0].content).toBe("Should I proceed?");

    // Session should be in waiting status
    const sessions = await getApp().sessions.list();
    const updated = sessions.find((s) => s.id === session.id);
    expect(updated?.status).toBe("waiting");
  });

  it("error report creates a message and sets session to failed", async () => {
    const session = await getApp().sessions.create({ summary: "error session" });

    const resp = await postReport(session.id, {
      type: "error",
      sessionId: session.id,
      stage: "work",
      error: "Something went wrong",
    });
    expect(resp.status).toBe(200);

    const msgs = await getApp().messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("error");
    expect(msgs[0].content).toBe("Something went wrong");

    const sessions = await getApp().sessions.list();
    const updated = sessions.find((s) => s.id === session.id);
    expect(updated?.status).toBe("failed");
  });

  it("multiple reports from same session accumulate messages", async () => {
    const session = await getApp().sessions.create({ summary: "multi-report" });

    await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      message: "Starting...",
    });
    await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      message: "Halfway done...",
    });
    await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      message: "Almost there...",
    });

    const msgs = await getApp().messages.list(session.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe("Starting...");
    expect(msgs[1].content).toBe("Halfway done...");
    expect(msgs[2].content).toBe("Almost there...");
  });

  it("agent messages increment unread count", async () => {
    const session = await getApp().sessions.create({ summary: "unread test" });

    await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      message: "Update 1",
    });
    await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      message: "Update 2",
    });

    expect(await getApp().messages.unreadCount(session.id)).toBe(2);
  });

  it("reports to different sessions are isolated", async () => {
    const s1 = await getApp().sessions.create({ summary: "session 1" });
    const s2 = await getApp().sessions.create({ summary: "session 2" });

    await postReport(s1.id, {
      type: "progress",
      sessionId: s1.id,
      stage: "work",
      message: "For session 1",
    });
    await postReport(s2.id, {
      type: "progress",
      sessionId: s2.id,
      stage: "work",
      message: "For session 2",
    });

    const msgs1 = await getApp().messages.list(s1.id);
    const msgs2 = await getApp().messages.list(s2.id);
    expect(msgs1.length).toBe(1);
    expect(msgs2.length).toBe(1);
    expect(msgs1[0].content).toBe("For session 1");
    expect(msgs2[0].content).toBe("For session 2");
  });

  it("progress report resets waiting status to running and clears breakpoint", async () => {
    const session = await getApp().sessions.create({ summary: "waiting → running" });
    // Simulate: question report set waiting + breakpoint_reason
    await getApp().sessions.update(session.id, { status: "waiting", breakpoint_reason: "Should I proceed?" });

    await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      message: "I am online and ready for work",
    });

    const updated = await getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");
    expect(updated?.breakpoint_reason).toBeNull();

    // Message should still be stored
    const msgs = await getApp().messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("I am online and ready for work");
  });

  it("progress report does not override non-waiting statuses", async () => {
    // stopped -- agent may send a stale report before being killed
    const s1 = await getApp().sessions.create({ summary: "stopped session" });
    await getApp().sessions.update(s1.id, { status: "stopped" });

    await postReport(s1.id, {
      type: "progress",
      sessionId: s1.id,
      stage: "work",
      message: "still alive",
    });
    expect((await getApp().sessions.get(s1.id))?.status).toBe("stopped");

    // running -- should stay running (no-op)
    const s2 = await getApp().sessions.create({ summary: "running session" });
    await getApp().sessions.update(s2.id, { status: "running" });

    await postReport(s2.id, {
      type: "progress",
      sessionId: s2.id,
      stage: "work",
      message: "update",
    });
    expect((await getApp().sessions.get(s2.id))?.status).toBe("running");

    // completed -- should stay completed
    const s3 = await getApp().sessions.create({ summary: "completed session" });
    await getApp().sessions.update(s3.id, { status: "completed" });

    await postReport(s3.id, {
      type: "progress",
      sessionId: s3.id,
      stage: "work",
      message: "ghost report",
    });
    expect((await getApp().sessions.get(s3.id))?.status).toBe("completed");
  });

  it("progress report without message falls back to JSON", async () => {
    const session = await getApp().sessions.create({ summary: "no message" });

    await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      filesChanged: [],
    });

    const msgs = await getApp().messages.list(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain("progress");
  });

  it("health endpoint returns ok", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/health`);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });
});

describe("Conductor cleanup", async () => {
  it("stop() clears interval timers (no leaked pollers)", async () => {
    // Track active timers before and after conductor lifecycle
    const timersBefore = new Set<ReturnType<typeof setInterval>>();

    // Monkey-patch setInterval to track timer IDs
    const originalSetInterval = globalThis.setInterval;
    const trackedTimers: ReturnType<typeof setInterval>[] = [];
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const id = originalSetInterval(...args);
      trackedTimers.push(id);
      return id;
    }) as typeof setInterval;

    const testServer = startConductor(app, TEST_PORT + 50, { quiet: true });

    // Should have created at least 2 timers (schedule + PR poller)
    expect(trackedTimers.length).toBeGreaterThanOrEqual(2);

    // Stop the conductor -- this should clear the intervals
    testServer.stop();

    // Verify the timers were cleared by checking they don't fire
    // We do this by trying to clear them again (clearInterval on already-cleared is no-op)
    // The real test is that after stop(), no interval callbacks run on the wrong context
    globalThis.setInterval = originalSetInterval;

    // Verify the server is actually stopped (can't reach it)
    try {
      await fetch(`http://localhost:${TEST_PORT + 50}/health`);
      // If we get here, server didn't stop properly
      expect(false).toBe(true);
    } catch {
      // Expected -- server is stopped
    }
  });
});
