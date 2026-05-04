/**
 * Tests for the `/hooks/status` passthrough that routes non-hook report
 * payloads (`type: "question"`, etc.) through the same report pipeline the
 * claude runtime's conductor-channel uses. This keeps agent-sdk sessions at
 * parity with the claude runtime's `report(question)` tool.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { startConductor } from "../conductor/conductor.js";
import { withTestContext, getApp } from "./test-helpers.js";

const TEST_PORT = 19197;

withTestContext();

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

async function post(sessionId: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("Conductor /hooks/status type=question passthrough", async () => {
  it("agent-sdk ask_user shape sets session waiting with breakpoint_reason", async () => {
    const session = await getApp().sessions.create({ summary: "ask_user test" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running" });

    const resp = await post(session.id, {
      type: "question",
      sessionId: session.id,
      stage: "plan",
      message: "Which database backend do you prefer?",
      context: "currently running sqlite, considering postgres",
      source: "agent-sdk-ask-user",
      timestamp: new Date().toISOString(),
    });

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.mapped).toBe("question");

    const updated = await getApp().sessions.get(session.id);
    expect(updated?.status).toBe("waiting");
    expect(updated?.breakpoint_reason).toBe("Which database backend do you prefer?");
  });

  it("logs agent_question event and emits to the event audit trail", async () => {
    const session = await getApp().sessions.create({ summary: "audit test" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running" });

    await post(session.id, {
      type: "question",
      sessionId: session.id,
      stage: "plan",
      message: "Proceed?",
      source: "agent-sdk-ask-user",
    });

    const events = await getApp().events.list(session.id, { type: "agent_question" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const evt = events.find((e) => e.type === "agent_question");
    expect(evt).toBeTruthy();
    expect(evt!.actor).toBe("agent");
  });

  it("appends an agent chat message so the UI renders the question", async () => {
    const session = await getApp().sessions.create({ summary: "chat test" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running" });

    await post(session.id, {
      type: "question",
      sessionId: session.id,
      stage: "plan",
      message: "Keep going?",
      source: "agent-sdk-ask-user",
    });

    const msgs = await getApp().messages.list(session.id);
    const agentQuestion = msgs.find((m) => m.role === "agent" && m.type === "question");
    expect(agentQuestion).toBeTruthy();
    expect(agentQuestion!.content).toContain("Keep going?");
  });

  it("accepts the claude-runtime `question` report shape (parity with report tool)", async () => {
    // The claude-runtime `report(type=question)` path goes through /api/channel/:sessionId,
    // but the passthrough here should also accept the same `question` field name for
    // forward-compat with any source that prefers it over `message`.
    const session = await getApp().sessions.create({ summary: "parity test" });
    await getApp().sessions.update(session.id, { session_id: `ark-s-${session.id}`, status: "running" });

    const resp = await post(session.id, {
      type: "question",
      sessionId: session.id,
      stage: "review",
      question: "PR looks good, merge now?",
    });
    expect(resp.status).toBe(200);

    const updated = await getApp().sessions.get(session.id);
    expect(updated?.status).toBe("waiting");
    expect(updated?.breakpoint_reason).toBe("PR looks good, merge now?");
  });

  it("hook_event_name payloads still take the legacy hook path", async () => {
    const session = await getApp().sessions.create({ summary: "regression test" });
    // pre-populate session_id so the hook-driven transition to "running"
    // satisfies the invariant (post-launch.ts does this in production).
    await getApp().sessions.update(session.id, { status: "ready", session_id: `ark-s-${session.id}` });

    const resp = await post(session.id, { hook_event_name: "SessionStart" });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    // Not "question" -- this should still follow the classic hook mapping.
    expect(body.mapped).not.toBe("question");

    const updated = await getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });
});
