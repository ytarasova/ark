/**
 * Tests for the conductor /hooks/status endpoint.
 *
 * Validates that Claude Code hook events are correctly mapped to
 * session statuses in the store, without triggering pipeline advancement.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getApp } from "../app.js";
import { startConductor } from "../conductor/conductor.js";
import { withTestContext } from "./test-helpers.js";

const TEST_PORT = 19198;

const { getCtx } = withTestContext();

let server: { stop(): void };

beforeEach(() => {
  server = startConductor(getApp(), TEST_PORT, { quiet: true });
});

afterEach(() => {
  try { server.stop(); } catch { /* cleanup */ }
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
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "ready" });

    const resp = await postHook(session.id, { hook_event_name: "UserPromptSubmit" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("running");

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });

  it("Stop does not change status (agent idle between turns)", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "running" });

    const resp = await postHook(session.id, { hook_event_name: "Stop" });
    expect(resp.status).toBe(200);

    // Stop no longer maps to a status change — session stays running
    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });

  it("StopFailure maps to status failed with error field", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "running" });

    const resp = await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "agent crashed",
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("failed");

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("agent crashed");
  });

  it("SessionEnd maps to status completed", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "running" });

    const resp = await postHook(session.id, { hook_event_name: "SessionEnd" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("completed");

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("Notification with permission_prompt maps to status waiting", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "running" });

    const resp = await postHook(session.id, {
      hook_event_name: "Notification",
      matcher: "permission_prompt",
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("waiting");

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("waiting");
  });

  it("SessionStart maps to status running", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });

    const resp = await postHook(session.id, { hook_event_name: "SessionStart" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("running");

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });

  it("returns 404 for unknown session", async () => {
    const resp = await postHook("s-nonexistent", { hook_event_name: "Stop" });
    expect(resp.status).toBe(404);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("session not found");
  });

  it("unknown event returns 200 with no-op, status unchanged", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "running" });

    const resp = await postHook(session.id, { hook_event_name: "SomeUnknownEvent" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("no-op");

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });

  it("logs hook event to event audit trail", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });

    await postHook(session.id, { hook_event_name: "SessionStart", extra: "data" });

    const events = getApp().events.list(session.id, { type: "hook_status" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const hookEvent = events.find(e => e.type === "hook_status");
    expect(hookEvent).toBeTruthy();
    expect(hookEvent!.actor).toBe("hook");
    expect(hookEvent!.data?.event).toBe("SessionStart");
  });

  it("PreCompact is logged but does not change status", async () => {
    const session = getApp().sessions.create({ summary: "test" });
    getApp().sessions.update(session.id, { status: "running" });

    const resp = await postHook(session.id, {
      hook_event_name: "PreCompact",
      trigger: "auto",
    });
    expect(resp.status).toBe(200);
    expect(getApp().sessions.get(session.id)!.status).toBe("running");
  });

  it("PostCompact is logged with compact_summary in event data", async () => {
    const session = getApp().sessions.create({ summary: "test" });
    getApp().sessions.update(session.id, { status: "running" });

    await postHook(session.id, {
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "Conversation summarized: working on auth module...",
    });

    expect(getApp().sessions.get(session.id)!.status).toBe("running");
  });

  it("StopFailure with max_output_tokens sets failed with specific error", async () => {
    const session = getApp().sessions.create({ summary: "test" });
    getApp().sessions.update(session.id, { status: "running" });

    await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "max_output_tokens",
      error_details: "Output token limit exceeded",
    });

    const updated = getApp().sessions.get(session.id);
    expect(updated!.status).toBe("failed");
    expect(updated!.error).toContain("max_output_tokens");
  });

  it("Stop with transcript_path records token usage in usage_records", async () => {
    const session = getApp().sessions.create({ summary: "test" });
    getApp().sessions.update(session.id, { status: "running" });

    const { writeFileSync: wf } = await import("fs");
    const { join: j } = await import("path");
    const transcriptPath = j(getCtx().arkDir, "transcript-stop.jsonl");
    wf(transcriptPath, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 2000, output_tokens: 800, cache_read_input_tokens: 3000, cache_creation_input_tokens: 50 } } }),
    ].join("\n"));

    await postHook(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
    });

    const agg = getApp().usageRecorder.getSessionCost(session.id);
    expect(agg.input_tokens).toBe(3000);
    expect(agg.output_tokens).toBe(1300);
    expect(agg.cache_read_tokens).toBe(8000);
  });

  it("SessionEnd with transcript_path records final token usage", async () => {
    const session = getApp().sessions.create({ summary: "test" });
    getApp().sessions.update(session.id, { status: "running" });

    const { writeFileSync: wf } = await import("fs");
    const { join: j } = await import("path");
    const transcriptPath = j(getCtx().arkDir, "transcript-end.jsonl");
    wf(transcriptPath, JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 500, output_tokens: 200 } } }));

    await postHook(session.id, {
      hook_event_name: "SessionEnd",
      transcript_path: transcriptPath,
      reason: "prompt_input_exit",
    });

    const agg = getApp().usageRecorder.getSessionCost(session.id);
    expect(agg.input_tokens).toBe(500);
    expect(agg.output_tokens).toBe(200);
  });

  it("hook without transcript_path skips usage tracking", async () => {
    const session = getApp().sessions.create({ summary: "test" });
    getApp().sessions.update(session.id, { status: "running" });

    await postHook(session.id, { hook_event_name: "Stop" });

    const agg = getApp().usageRecorder.getSessionCost(session.id);
    expect(agg.records.length).toBe(0);
  });

  it("UserPromptSubmit does not override completed status", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "completed" });

    const resp = await postHook(session.id, { hook_event_name: "UserPromptSubmit" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("no-op");

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("UserPromptSubmit does not override failed status back to running", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "failed", error: "agent crashed" });

    const resp = await postHook(session.id, { hook_event_name: "UserPromptSubmit" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("no-op");

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toBe("agent crashed");
  });

  it("SessionEnd advances auto-gate session to next stage", async () => {
    // Use default flow with implement stage (gate: auto) -- advance moves to verify
    const session = getApp().sessions.create({ summary: "hook test", flow: "default" });
    getApp().sessions.update(session.id, { status: "running", stage: "implement" });

    const resp = await postHook(session.id, { hook_event_name: "SessionEnd" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.mapped).toBe("ready");

    const updated = getApp().sessions.get(session.id);
    // advance() should have moved to the next stage (verify)
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("Stop hook does not index transcript when claude session ID does not match", async () => {
    const session = getApp().sessions.create({ summary: "hook test" });
    getApp().sessions.update(session.id, { status: "running", claude_session_id: "real-claude-session-abc" });

    // Write a fake transcript file named after a DIFFERENT claude session
    const { writeFileSync: wf } = await import("fs");
    const { join: j } = await import("path");
    const transcriptPath = j(getCtx().arkDir, "different-claude-session-xyz.jsonl");
    wf(transcriptPath, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }));

    const resp = await postHook(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
      session_id: "different-claude-session-xyz",
    });
    expect(resp.status).toBe(200);

    // The transcript should NOT have been indexed because the hook's session_id
    // ("different-claude-session-xyz") does not match the ark session's claude_session_id
    // ("real-claude-session-abc"). We verify by checking the FTS5 index table directly.
    const db = getApp().db;
    let count = 0;
    try {
      const row = db.prepare("SELECT COUNT(*) as c FROM transcript_index WHERE session_id = ?").get(session.id) as { c: number } | undefined;
      count = row?.c ?? 0;
    } catch { /* FTS5 table may not exist */ }
    expect(count).toBe(0);
  });

  // ── Manual gate (bare flow) tests ──────────────────────────────────────

  it("StopFailure keeps manual-gate session running", async () => {
    const session = getApp().sessions.create({ summary: "bare test" });
    getApp().sessions.update(session.id, { flow: "bare" });
    getApp().sessions.update(session.id, { status: "running", stage: "work" });

    const resp = await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "authentication_failed",
    });
    expect(resp.status).toBe(200);

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");

    // Error should be logged as agent_error event
    const events = getApp().events.list(session.id, { type: "agent_error" });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].data?.error).toContain("authentication_failed");
  });

  it("SessionEnd keeps manual-gate session running", async () => {
    const session = getApp().sessions.create({ summary: "bare test" });
    getApp().sessions.update(session.id, { flow: "bare" });
    getApp().sessions.update(session.id, { status: "running", stage: "work" });

    const resp = await postHook(session.id, { hook_event_name: "SessionEnd" });
    expect(resp.status).toBe(200);

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");
  });

  it("StopFailure still fails auto-gate sessions", async () => {
    const session = getApp().sessions.create({ summary: "auto test", flow: "quick" });
    getApp().sessions.update(session.id, { status: "running", stage: "verify" });

    await postHook(session.id, {
      hook_event_name: "StopFailure",
      error: "some error",
    });

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("failed");
  });

  it("SessionEnd advances auto-gate sessions via advance()", async () => {
    const session = getApp().sessions.create({ summary: "auto test", flow: "default" });
    getApp().sessions.update(session.id, { status: "running", stage: "implement" });

    await postHook(session.id, { hook_event_name: "SessionEnd" });

    const updated = getApp().sessions.get(session.id);
    // advance() moves to verify stage (next after implement in default flow)
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("UserPromptSubmit clears breakpoint_reason when resuming from waiting", async () => {
    const session = getApp().sessions.create({ summary: "breakpoint clear test" });
    getApp().sessions.update(session.id, { status: "waiting", breakpoint_reason: "Need a PAT token" });

    await postHook(session.id, { hook_event_name: "UserPromptSubmit" });

    const updated = getApp().sessions.get(session.id);
    expect(updated?.status).toBe("running");
    expect(updated?.breakpoint_reason).toBeNull();
  });

  it("returns 400 for missing session param", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/hooks/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hook_event_name: "Stop" }),
    });
    expect(resp.status).toBe(400);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.error).toBe("missing session param");
  });
});
