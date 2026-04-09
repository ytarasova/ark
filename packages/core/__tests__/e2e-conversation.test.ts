/**
 * End-to-end tests for the unified conversation view.
 *
 * Tests the full flow: hook event -> transcript indexing -> conversation query/search.
 * Validates that the conductor's /hooks/status endpoint triggers indexSession(),
 * and that getSessionConversation / searchSessionConversation / searchTranscripts
 * return correct, scoped, deduplicated results.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import {
  getSession, updateSession,
} from "../index.js";
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { startConductor } from "../conductor.js";
import { getSessionConversation, searchSessionConversation, searchTranscripts } from "../search.js";

const TEST_PORT = 19197;
let app: AppContext;
let server: { stop(): void };

beforeEach(async () => {
  if (app) { await app.shutdown(); clearApp(); }
  app = AppContext.forTest(); setApp(app); await app.boot();

  server = startConductor(app, TEST_PORT, { quiet: true });
});

afterEach(() => {
  try { server.stop(); } catch {}
});

afterAll(async () => {
  if (app) { await app.shutdown(); clearApp(); }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Claude session ID used in hook payloads — must appear in the transcript path
 *  to pass the conductor's "belongs to this session" guard. */
const CLAUDE_SESSION_ID = "test-claude-session";

async function postHookStatus(sessionId: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`http://localhost:${TEST_PORT}/hooks/status?session=${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: CLAUDE_SESSION_ID, ...payload }),
  });
}

function writeTranscript(dir: string, filename: string, lines: object[]): string {
  // Include CLAUDE_SESSION_ID in the path so the conductor's guard
  // (transcriptPath.includes(hookClaudeSession)) passes
  const subdir = join(dir, CLAUDE_SESSION_ID);
  mkdirSync(subdir, { recursive: true });
  const path = join(subdir, filename);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join("\n"));
  return path;
}

function appendTranscript(path: string, lines: object[]): void {
  appendFileSync(path, "\n" + lines.map(l => JSON.stringify(l)).join("\n"));
}

function userTurn(content: string, ts: string) {
  return { type: "user", message: { role: "user", content }, timestamp: ts };
}

function assistantTurn(content: string, ts: string, usage?: Record<string, number>) {
  return {
    type: "assistant",
    message: { role: "assistant", content, ...(usage ? { usage } : {}) },
    timestamp: ts,
  };
}

function toolUseTurn(ts: string) {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "/foo" } }] },
    timestamp: ts,
  };
}

function toolResultTurn(ts: string) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents here are quite long enough" }] },
    timestamp: ts,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Hook -> Index -> Query flow", () => {
  it("Stop hook with transcript_path indexes and getSessionConversation returns turns", async () => {
    const session = getApp().sessions.create({ summary: "e2e-conv-basic" });
    updateSession(session.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });

    const transcriptPath = writeTranscript(app.config.arkDir, "conv-basic.jsonl", [
      userTurn("fix the auth bug in the login module", "2026-01-01T00:01:00Z"),
      assistantTurn("I will fix the authentication issue in the login module now", "2026-01-01T00:02:00Z"),
      userTurn("also check the session timeout logic please", "2026-01-01T00:03:00Z"),
      assistantTurn("I have checked and fixed the session timeout handling", "2026-01-01T00:04:00Z"),
    ]);

    const resp = await postHookStatus(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
    });
    expect(resp.status).toBe(200);

    const turns = getSessionConversation(session.id);
    expect(turns.length).toBe(4);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toContain("auth bug");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].content).toContain("authentication");
    expect(turns[2].content).toContain("session timeout");
    expect(turns[3].content).toContain("timeout handling");
  });
});

describe("E2E: Incremental indexing", () => {
  it("second Stop hook adds new messages without duplicates", async () => {
    const session = getApp().sessions.create({ summary: "e2e-incremental" });
    updateSession(session.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });

    const transcriptPath = writeTranscript(app.config.arkDir, "conv-incr.jsonl", [
      userTurn("implement the caching layer for redis", "2026-01-01T00:01:00Z"),
      assistantTurn("I will implement the Redis caching layer now", "2026-01-01T00:02:00Z"),
    ]);

    // First Stop hook — indexes initial messages
    await postHookStatus(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
    });

    let turns = getSessionConversation(session.id);
    expect(turns.length).toBe(2);

    // Append more conversation to the transcript
    appendTranscript(transcriptPath, [
      userTurn("now add cache invalidation on write", "2026-01-01T00:03:00Z"),
      assistantTurn("I have added write-through cache invalidation", "2026-01-01T00:04:00Z"),
    ]);

    // Simulate going back to running then stopping again
    updateSession(session.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });
    await postHookStatus(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
    });

    turns = getSessionConversation(session.id);
    expect(turns.length).toBe(4); // not 6 (no duplicates)
    expect(turns[0].content).toContain("caching layer");
    expect(turns[2].content).toContain("cache invalidation");
    expect(turns[3].content).toContain("write-through");
  });
});

describe("E2E: Per-session search", () => {
  it("searchSessionConversation is scoped to one session", async () => {
    // Session A — talks about authentication
    const sessionA = getApp().sessions.create({ summary: "e2e-search-A" });
    updateSession(sessionA.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });
    const pathA = writeTranscript(app.config.arkDir, "conv-a.jsonl", [
      userTurn("fix the authentication middleware vulnerability", "2026-01-01T00:01:00Z"),
      assistantTurn("I have patched the authentication middleware to prevent bypass", "2026-01-01T00:02:00Z"),
    ]);
    await postHookStatus(sessionA.id, { hook_event_name: "Stop", transcript_path: pathA });

    // Session B — talks about database
    const sessionB = getApp().sessions.create({ summary: "e2e-search-B" });
    updateSession(sessionB.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });
    const pathB = writeTranscript(app.config.arkDir, "conv-b.jsonl", [
      userTurn("optimize the database connection pooling", "2026-01-01T00:01:00Z"),
      assistantTurn("I have optimized the database connection pool settings", "2026-01-01T00:02:00Z"),
    ]);
    await postHookStatus(sessionB.id, { hook_event_name: "Stop", transcript_path: pathB });

    // Search A for "authentication" — should find results
    const resultsA = searchSessionConversation(sessionA.id, "authentication");
    expect(resultsA.length).toBeGreaterThan(0);
    for (const r of resultsA) {
      expect(r.sessionId).toBe(sessionA.id);
    }

    // Search B for "authentication" — should find nothing (it's about database)
    const resultsB = searchSessionConversation(sessionB.id, "authentication");
    expect(resultsB.length).toBe(0);

    // Search B for "database" — should find results
    const resultsBdb = searchSessionConversation(sessionB.id, "database");
    expect(resultsBdb.length).toBeGreaterThan(0);
    for (const r of resultsBdb) {
      expect(r.sessionId).toBe(sessionB.id);
    }
  });
});

describe("E2E: Cross-session search", () => {
  it("searchTranscripts finds matches across both sessions via FTS5", async () => {
    // Session C — mentions "deployment pipeline"
    const sessionC = getApp().sessions.create({ summary: "e2e-cross-C" });
    updateSession(sessionC.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });
    const pathC = writeTranscript(app.config.arkDir, "conv-c.jsonl", [
      assistantTurn("I have configured the deployment pipeline for staging", "2026-01-01T00:01:00Z"),
    ]);
    await postHookStatus(sessionC.id, { hook_event_name: "Stop", transcript_path: pathC });

    // Session D — also mentions "deployment"
    const sessionD = getApp().sessions.create({ summary: "e2e-cross-D" });
    updateSession(sessionD.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });
    const pathD = writeTranscript(app.config.arkDir, "conv-d.jsonl", [
      assistantTurn("Fixed the deployment rollback mechanism for production", "2026-01-01T00:01:00Z"),
    ]);
    await postHookStatus(sessionD.id, { hook_event_name: "Stop", transcript_path: pathD });

    // Cross-session search for "deployment"
    const results = searchTranscripts("deployment");
    expect(results.length).toBe(2);
    const sessionIds = results.map(r => r.sessionId);
    expect(sessionIds).toContain(sessionC.id);
    expect(sessionIds).toContain(sessionD.id);

    // Verify each result mentions "deployment"
    for (const r of results) {
      expect(r.source).toBe("transcript");
    }
  });
});

describe("E2E: Token usage stored on hook", () => {
  it("Stop hook with transcript_path stores aggregated token usage", async () => {
    const session = getApp().sessions.create({ summary: "e2e-usage" });
    updateSession(session.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });

    const transcriptPath = writeTranscript(app.config.arkDir, "conv-usage.jsonl", [
      userTurn("analyze the performance bottleneck in the query", "2026-01-01T00:01:00Z"),
      assistantTurn("I will analyze the performance issue", "2026-01-01T00:02:00Z", {
        input_tokens: 1000, output_tokens: 500,
        cache_read_input_tokens: 5000, cache_creation_input_tokens: 100,
      }),
      userTurn("what did you find in the profiler output", "2026-01-01T00:03:00Z"),
      assistantTurn("The bottleneck is in the N+1 query in the users endpoint", "2026-01-01T00:04:00Z", {
        input_tokens: 2000, output_tokens: 800,
        cache_read_input_tokens: 3000, cache_creation_input_tokens: 50,
      }),
    ]);

    await postHookStatus(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
    });

    const updated = getSession(session.id);
    expect(updated).toBeTruthy();
    const config = typeof updated!.config === "string"
      ? JSON.parse(updated!.config) : updated!.config;
    expect(config.usage).toBeDefined();
    expect(config.usage.input_tokens).toBe(3000);   // 1000 + 2000
    expect(config.usage.output_tokens).toBe(1300);   // 500 + 800
    expect(config.usage.cache_read_input_tokens).toBe(8000);  // 5000 + 3000
    expect(config.usage.cache_creation_input_tokens).toBe(150); // 100 + 50
    expect(config.usage.total_tokens).toBe(12450);   // 3000 + 1300 + 8000 + 150
  });
});

describe("E2E: Noise filtering", () => {
  it("tool_use and tool_result entries are not in getSessionConversation", async () => {
    const session = getApp().sessions.create({ summary: "e2e-noise" });
    updateSession(session.id, { status: "running", claude_session_id: CLAUDE_SESSION_ID });

    const transcriptPath = writeTranscript(app.config.arkDir, "conv-noise.jsonl", [
      userTurn("please read the config file and explain it", "2026-01-01T00:01:00Z"),
      toolUseTurn("2026-01-01T00:02:00Z"),
      toolResultTurn("2026-01-01T00:03:00Z"),
      assistantTurn("The config file sets up the database connection and logging levels", "2026-01-01T00:04:00Z"),
      userTurn("thanks now update the logging level to debug", "2026-01-01T00:05:00Z"),
      toolUseTurn("2026-01-01T00:06:00Z"),
      toolResultTurn("2026-01-01T00:07:00Z"),
      assistantTurn("I have updated the logging level to debug in the configuration", "2026-01-01T00:08:00Z"),
    ]);

    await postHookStatus(session.id, {
      hook_event_name: "Stop",
      transcript_path: transcriptPath,
    });

    const turns = getSessionConversation(session.id);
    // Should only have the 4 real messages, not the tool_use/tool_result noise
    expect(turns.length).toBe(4);
    for (const turn of turns) {
      expect(turn.content).not.toContain("tool_use");
      expect(turn.content).not.toContain("tool_result");
    }
    expect(turns[0].content).toContain("config file");
    expect(turns[1].content).toContain("database connection");
    expect(turns[2].content).toContain("logging level");
    expect(turns[3].content).toContain("debug");
  });
});
