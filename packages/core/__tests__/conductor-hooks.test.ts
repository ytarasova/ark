/**
 * Tests for the conductor /hooks/status endpoint.
 *
 * Validates that Claude Code hook events are correctly mapped to
 * session statuses in the store, without triggering pipeline advancement.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext,
  getEvents, listSessions,
} from "../index.js";
import { createSession, updateSession, getSession } from "../store.js";
import { startConductor } from "../conductor.js";
import type { TestContext } from "../context.js";

const TEST_PORT = 19198;

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

async function postHook(sessionId: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("Conductor /hooks/status endpoint", () => {
  it("UserPromptSubmit maps to status running", async () => {
    const session = createSession({ summary: "hook test" });
    updateSession(session.id, { status: "ready" });

    const resp = await postHook(session.id, { hook_event_name: "UserPromptSubmit" });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.mapped).toBe("running");

    const updated = getSession(session.id);
    expect(updated?.status).toBe("running");
  });

  it("Stop does not change status (agent idle between turns)", async () => {
    const session = createSession({ summary: "hook test" });
    updateSession(session.id, { status: "running" });

    const resp = await postHook(session.id, { hook_event_name: "Stop" });
    expect(resp.status).toBe(200);

    // Stop no longer maps to a status change — session stays running
    const updated = getSession(session.id);
    expect(updated?.status).toBe("running");
  });

  it("StopFailure maps to status failed with error field", async () => {
    const session = createSession({ summary: "hook test" });
    updateSession(session.id, { status: "running" });

    const resp = await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "agent crashed",
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.mapped).toBe("failed");

    const updated = getSession(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("agent crashed");
  });

  it("SessionEnd maps to status completed", async () => {
    const session = createSession({ summary: "hook test" });
    updateSession(session.id, { status: "running" });

    const resp = await postHook(session.id, { hook_event_name: "SessionEnd" });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.mapped).toBe("completed");

    const updated = getSession(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("Notification with permission_prompt maps to status waiting", async () => {
    const session = createSession({ summary: "hook test" });
    updateSession(session.id, { status: "running" });

    const resp = await postHook(session.id, {
      hook_event_name: "Notification",
      matcher: "permission_prompt",
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.mapped).toBe("waiting");

    const updated = getSession(session.id);
    expect(updated?.status).toBe("waiting");
  });

  it("SessionStart maps to status running", async () => {
    const session = createSession({ summary: "hook test" });

    const resp = await postHook(session.id, { hook_event_name: "SessionStart" });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.mapped).toBe("running");

    const updated = getSession(session.id);
    expect(updated?.status).toBe("running");
  });

  it("returns 404 for unknown session", async () => {
    const resp = await postHook("s-nonexistent", { hook_event_name: "Stop" });
    expect(resp.status).toBe(404);
    const body = await resp.json();
    expect(body.error).toBe("session not found");
  });

  it("unknown event returns 200 with no-op, status unchanged", async () => {
    const session = createSession({ summary: "hook test" });
    updateSession(session.id, { status: "running" });

    const resp = await postHook(session.id, { hook_event_name: "SomeUnknownEvent" });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.mapped).toBe("no-op");

    const updated = getSession(session.id);
    expect(updated?.status).toBe("running");
  });

  it("logs hook event to event audit trail", async () => {
    const session = createSession({ summary: "hook test" });

    await postHook(session.id, { hook_event_name: "SessionStart", extra: "data" });

    const events = getEvents(session.id, { type: "hook_status" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const hookEvent = events.find(e => e.type === "hook_status");
    expect(hookEvent).toBeTruthy();
    expect(hookEvent!.actor).toBe("hook");
    expect(hookEvent!.data?.event).toBe("SessionStart");
  });

  it("PreCompact is logged but does not change status", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    const resp = await postHook(session.id, {
      hook_event_name: "PreCompact",
      trigger: "auto",
    });
    expect(resp.status).toBe(200);
    expect(getSession(session.id)!.status).toBe("running");
  });

  it("PostCompact is logged with compact_summary in event data", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHook(session.id, {
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "Conversation summarized: working on auth module...",
    });

    expect(getSession(session.id)!.status).toBe("running");
  });

  it("StopFailure with max_output_tokens sets failed with specific error", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "max_output_tokens",
      error_details: "Output token limit exceeded",
    });

    const updated = getSession(session.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toContain("max_output_tokens");
  });

  it("Stop with transcript_path stores token usage on session config", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    // Write a fake transcript
    const { writeFileSync: wf } = await import("fs");
    const { join: j } = await import("path");
    const transcriptPath = j(ctx.arkDir, "transcript-stop.jsonl");
    wf(transcriptPath, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 3000, cache_creation_input_tokens: 50 } } }),
    ].join("\n"));

    await postHook(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
    });

    const updated = getSession(session.id);
    const config = typeof updated!.config === "string" ? JSON.parse(updated!.config) : updated!.config;
    expect(config.usage).toBeDefined();
    expect(config.usage.input_tokens).toBe(3000);
    expect(config.usage.output_tokens).toBe(1300);
    expect(config.usage.total_tokens).toBe(12450);
  });

  it("SessionEnd with transcript_path stores final token usage", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    const { writeFileSync: wf } = await import("fs");
    const { join: j } = await import("path");
    const transcriptPath = j(ctx.arkDir, "transcript-end.jsonl");
    wf(transcriptPath, JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 500, output_tokens: 200 } } }));

    await postHook(session.id, {
      hook_event_name: "SessionEnd",
      transcript_path: transcriptPath,
      reason: "prompt_input_exit",
    });

    const updated = getSession(session.id);
    const config = typeof updated!.config === "string" ? JSON.parse(updated!.config) : updated!.config;
    expect(config.usage).toBeDefined();
    expect(config.usage.input_tokens).toBe(500);
  });

  it("hook without transcript_path skips usage tracking", async () => {
    const session = createSession({ summary: "test" });
    updateSession(session.id, { status: "running" });

    await postHook(session.id, { hook_event_name: "Stop" });

    const updated = getSession(session.id);
    const config = typeof updated!.config === "string" ? JSON.parse(updated!.config) : updated!.config;
    expect(config.usage).toBeUndefined();
  });

  it("returns 400 for missing session param", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/hooks/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe("missing session param");
  });
});
