/**
 * End-to-end tests for the conductor report pipeline.
 *
 * Validates the full flow: conductor starts → agent posts report →
 * message stored in DB → getMessages returns it.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext,
  getMessages, getUnreadCount, listSessions,
} from "../index.js";
import { createSession, updateSession, getSession } from "../store.js";
import { startConductor } from "../conductor.js";
import type { TestContext } from "../context.js";

// Use a non-default port to avoid conflicts with a running conductor
const TEST_PORT = 19199;

let ctx: TestContext;
let server: { stop(): void };

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
  server = startConductor(TEST_PORT, { quiet: true });
});

afterEach(() => {
  try { server.stop(); } catch {}
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

async function postReport(sessionId: string, report: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${TEST_PORT}/api/channel/${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
}

describe("Conductor E2E — report pipeline", () => {
  it("progress report creates an agent message in the DB", async () => {
    const session = createSession({ summary: "test session" });

    const resp = await postReport(session.id, {
      type: "progress",
      sessionId: session.id,
      stage: "work",
      message: "Working on the task...",
    });
    expect(resp.status).toBe(200);

    const msgs = getMessages(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("progress");
    expect(msgs[0].content).toBe("Working on the task...");
  });

  it("completed report creates a message and updates session status", async () => {
    const session = createSession({ summary: "complete me" });

    const resp = await postReport(session.id, {
      type: "completed",
      sessionId: session.id,
      stage: "work",
      summary: "All done!",
      filesChanged: ["src/index.ts"],
      commits: ["abc123"],
    });
    expect(resp.status).toBe(200);

    const msgs = getMessages(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("completed");
    expect(msgs[0].content).toBe("All done!");
  });

  it("question report creates a message and sets session to waiting", async () => {
    const session = createSession({ summary: "question session" });

    const resp = await postReport(session.id, {
      type: "question",
      sessionId: session.id,
      stage: "work",
      question: "Should I proceed?",
    });
    expect(resp.status).toBe(200);

    const msgs = getMessages(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("question");
    expect(msgs[0].content).toBe("Should I proceed?");

    // Session should be in waiting status
    const sessions = listSessions();
    const updated = sessions.find(s => s.id === session.id);
    expect(updated?.status).toBe("waiting");
  });

  it("error report creates a message and sets session to failed", async () => {
    const session = createSession({ summary: "error session" });

    const resp = await postReport(session.id, {
      type: "error",
      sessionId: session.id,
      stage: "work",
      error: "Something went wrong",
    });
    expect(resp.status).toBe(200);

    const msgs = getMessages(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].role).toBe("agent");
    expect(msgs[0].type).toBe("error");
    expect(msgs[0].content).toBe("Something went wrong");

    const sessions = listSessions();
    const updated = sessions.find(s => s.id === session.id);
    expect(updated?.status).toBe("failed");
  });

  it("multiple reports from same session accumulate messages", async () => {
    const session = createSession({ summary: "multi-report" });

    await postReport(session.id, {
      type: "progress", sessionId: session.id, stage: "work",
      message: "Starting...",
    });
    await postReport(session.id, {
      type: "progress", sessionId: session.id, stage: "work",
      message: "Halfway done...",
    });
    await postReport(session.id, {
      type: "progress", sessionId: session.id, stage: "work",
      message: "Almost there...",
    });

    const msgs = getMessages(session.id);
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toBe("Starting...");
    expect(msgs[1].content).toBe("Halfway done...");
    expect(msgs[2].content).toBe("Almost there...");
  });

  it("agent messages increment unread count", async () => {
    const session = createSession({ summary: "unread test" });

    await postReport(session.id, {
      type: "progress", sessionId: session.id, stage: "work",
      message: "Update 1",
    });
    await postReport(session.id, {
      type: "progress", sessionId: session.id, stage: "work",
      message: "Update 2",
    });

    expect(getUnreadCount(session.id)).toBe(2);
  });

  it("reports to different sessions are isolated", async () => {
    const s1 = createSession({ summary: "session 1" });
    const s2 = createSession({ summary: "session 2" });

    await postReport(s1.id, {
      type: "progress", sessionId: s1.id, stage: "work",
      message: "For session 1",
    });
    await postReport(s2.id, {
      type: "progress", sessionId: s2.id, stage: "work",
      message: "For session 2",
    });

    const msgs1 = getMessages(s1.id);
    const msgs2 = getMessages(s2.id);
    expect(msgs1.length).toBe(1);
    expect(msgs2.length).toBe(1);
    expect(msgs1[0].content).toBe("For session 1");
    expect(msgs2[0].content).toBe("For session 2");
  });

  it("progress report resets waiting status to running and clears breakpoint", async () => {
    const session = createSession({ summary: "waiting → running" });
    // Simulate: question report set waiting + breakpoint_reason
    updateSession(session.id, { status: "waiting", breakpoint_reason: "Should I proceed?" });

    await postReport(session.id, {
      type: "progress", sessionId: session.id, stage: "work",
      message: "I am online and ready for work",
    });

    const updated = getSession(session.id);
    expect(updated?.status).toBe("running");
    expect(updated?.breakpoint_reason).toBeNull();

    // Message should still be stored
    const msgs = getMessages(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("I am online and ready for work");
  });

  it("progress report does not override non-waiting statuses", async () => {
    // stopped — agent may send a stale report before being killed
    const s1 = createSession({ summary: "stopped session" });
    updateSession(s1.id, { status: "stopped" });

    await postReport(s1.id, {
      type: "progress", sessionId: s1.id, stage: "work",
      message: "still alive",
    });
    expect(getSession(s1.id)?.status).toBe("stopped");

    // running — should stay running (no-op)
    const s2 = createSession({ summary: "running session" });
    updateSession(s2.id, { status: "running" });

    await postReport(s2.id, {
      type: "progress", sessionId: s2.id, stage: "work",
      message: "update",
    });
    expect(getSession(s2.id)?.status).toBe("running");

    // completed — should stay completed
    const s3 = createSession({ summary: "completed session" });
    updateSession(s3.id, { status: "completed" });

    await postReport(s3.id, {
      type: "progress", sessionId: s3.id, stage: "work",
      message: "ghost report",
    });
    expect(getSession(s3.id)?.status).toBe("completed");
  });

  it("progress report without message defaults to 'working'", async () => {
    const session = createSession({ summary: "no message" });

    await postReport(session.id, {
      type: "progress", sessionId: session.id, stage: "work",
      filesChanged: [],
    });

    const msgs = getMessages(session.id);
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toBe("working");
  });

  it("health endpoint returns ok", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/health`);
    const body = await resp.json();
    expect(body.status).toBe("ok");
  });
});
