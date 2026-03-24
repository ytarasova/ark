/**
 * Tests for Claude Code session discovery — listClaudeSessions, getClaudeSession.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../index.js";
import { listClaudeSessions, getClaudeSession } from "../claude-sessions.js";

let ctx: TestContext;

function baseDir() {
  return join(ctx.arkDir, "claude-projects");
}

/** Minimum messages to pass the >1 message filter */
const MIN_MSGS = [
  { type: "user", message: { role: "user", content: "hello" }, timestamp: "2026-03-24T10:00:01Z" },
  { type: "assistant", message: { role: "assistant", content: "hi" }, timestamp: "2026-03-24T10:00:02Z" },
];

/** Write a fake JSONL transcript file under the test baseDir. Ensures minimum 2 messages. */
function writeTranscript(projectDirName: string, filename: string, lines: object[]) {
  const dir = join(baseDir(), projectDirName);
  mkdirSync(dir, { recursive: true });
  // Ensure at least 2 user/assistant messages so session passes filter
  const hasEnoughMsgs = lines.filter((l: any) => l.type === "user" || l.type === "assistant").length > 1;
  const allLines = hasEnoughMsgs ? lines : [...lines, ...MIN_MSGS];
  writeFileSync(join(dir, filename), allLines.map(l => JSON.stringify(l)).join("\n"));
}

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

// ── listClaudeSessions ──────────────────────────────────────────────────────

describe("listClaudeSessions", () => {
  it("returns empty array when baseDir does not exist", async () => {
    const sessions = await listClaudeSessions({ baseDir: join(ctx.arkDir, "nonexistent") });
    expect(sessions).toEqual([]);
  });

  it("returns empty array for an empty directory", async () => {
    mkdirSync(baseDir(), { recursive: true });
    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions).toEqual([]);
  });

  it("discovers sessions from JSONL files with correct metadata", async () => {
    writeTranscript("-Users-yana-Projects-ark", "abc-123.jsonl", [
      { type: "system", sessionId: "abc-123", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "fix the bug" }] }, timestamp: "2026-03-24T10:01:00Z" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll fix it" }] }, timestamp: "2026-03-24T10:02:00Z" },
    ]);

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions.length).toBe(1);

    const s = sessions[0];
    expect(s.sessionId).toBe("abc-123");
    expect(s.summary).toBe("fix the bug");
    expect(s.messageCount).toBe(2);
    expect(s.timestamp).toBe("2026-03-24T10:00:00Z");
    expect(s.lastActivity).toBe("2026-03-24T10:02:00Z");
    expect(s.transcriptPath).toContain("abc-123.jsonl");
  });

  it("decodes project path from directory name", async () => {
    writeTranscript("-Users-yana-Projects-ark", "s1.jsonl", [
      { type: "system", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions[0].project).toBe("/Users/yana/Projects/ark");
    expect(sessions[0].projectDir).toBe("-Users-yana-Projects-ark");
  });

  it("counts only user and assistant messages", async () => {
    writeTranscript("-test-proj", "s2.jsonl", [
      { type: "system", sessionId: "s2", timestamp: "2026-01-01T00:00:00Z" },
      { type: "user", message: { role: "user", content: "hello" }, timestamp: "2026-01-01T00:01:00Z" },
      { type: "assistant", message: { role: "assistant", content: "hi" }, timestamp: "2026-01-01T00:02:00Z" },
      { type: "user", message: { role: "user", content: "bye" }, timestamp: "2026-01-01T00:03:00Z" },
    ]);

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions[0].messageCount).toBe(3); // 2 user + 1 assistant
  });

  it("extracts summary from string content", async () => {
    writeTranscript("-str-proj", "s3.jsonl", [
      { type: "user", message: { role: "user", content: "refactor the auth module" }, timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions[0].summary).toBe("refactor the auth module");
  });

  it("extracts summary from array content", async () => {
    writeTranscript("-arr-proj", "s4.jsonl", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "deploy to staging" }] }, timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions[0].summary).toBe("deploy to staging");
  });

  it("sorts by most recent activity first", async () => {
    writeTranscript("-proj-a", "old.jsonl", [
      { type: "system", sessionId: "old", timestamp: "2025-01-01T00:00:00Z" },
      { type: "user", message: { role: "user", content: "old task" }, timestamp: "2025-01-01T01:00:00Z" },
      { type: "assistant", message: { role: "assistant", content: "ok" }, timestamp: "2025-01-01T01:01:00Z" },
    ]);
    writeTranscript("-proj-b", "new.jsonl", [
      { type: "system", sessionId: "new", timestamp: "2026-12-01T10:00:00Z" },
      { type: "user", message: { role: "user", content: "new task" }, timestamp: "2026-12-01T12:00:00Z" },
      { type: "assistant", message: { role: "assistant", content: "ok" }, timestamp: "2026-12-01T12:01:00Z" },
    ]);

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions.length).toBe(2);
    expect(sessions[0].sessionId).toBe("new");
    expect(sessions[1].sessionId).toBe("old");
  });

  it("skips subagent directories", async () => {
    // Write a normal session
    writeTranscript("-proj", "main-session.jsonl", [
      { type: "system", sessionId: "main-session", timestamp: "2026-01-01T00:00:00Z" },
      { type: "user", message: { role: "user", content: "main task" }, timestamp: "2026-01-01T00:01:00Z" },
    ]);

    // Write a subagent transcript inside a subdirectory (not a .jsonl at project level)
    const subagentDir = join(baseDir(), "-proj", "main-session", "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(subagentDir, "sub-agent.jsonl"), JSON.stringify({
      type: "user", message: { role: "user", content: "subagent task" }, timestamp: "2026-01-01T00:02:00Z",
    }));

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("main-session");
  });

  it("respects limit option", async () => {
    for (let i = 0; i < 5; i++) {
      writeTranscript("-limit-proj", `s-${i}.jsonl`, [
        { type: "system", sessionId: `s-${i}`, timestamp: `2026-01-0${i + 1}T00:00:00Z` },
        { type: "user", message: { role: "user", content: `task ${i}` }, timestamp: `2026-01-0${i + 1}T00:01:00Z` },
      ]);
    }

    const sessions = await listClaudeSessions({ baseDir: baseDir(), limit: 3 });
    expect(sessions.length).toBe(3);
  });

  it("filters by project name", async () => {
    writeTranscript("-Users-yana-Projects-ark", "ark-s.jsonl", [
      { type: "system", sessionId: "ark-s", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    writeTranscript("-Users-yana-Projects-other", "other-s.jsonl", [
      { type: "system", sessionId: "other-s", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const sessions = await listClaudeSessions({ baseDir: baseDir(), project: "ark" });
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("ark-s");
  });

  it("skips empty JSONL files", async () => {
    const dir = join(baseDir(), "-empty-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "empty.jsonl"), "");

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions).toEqual([]);
  });

  it("strips HTML tags from summary", async () => {
    writeTranscript("-html-proj", "html-s.jsonl", [
      { type: "user", message: { role: "user", content: "<context>some xml</context> fix this" }, timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const sessions = await listClaudeSessions({ baseDir: baseDir() });
    expect(sessions[0].summary).not.toContain("<context>");
    expect(sessions[0].summary).toContain("fix this");
  });
});

// ── getClaudeSession ────────────────────────────────────────────────────────

describe("getClaudeSession", () => {
  it("finds session by full ID", async () => {
    writeTranscript("-proj", "abc-def-123.jsonl", [
      { type: "system", sessionId: "abc-def-123", timestamp: "2026-01-01T00:00:00Z" },
      { type: "user", message: { role: "user", content: "found it" }, timestamp: "2026-01-01T00:01:00Z" },
    ]);

    const session = await getClaudeSession("abc-def-123", { baseDir: baseDir() });
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("abc-def-123");
    expect(session!.summary).toBe("found it");
  });

  it("finds session by prefix", async () => {
    writeTranscript("-proj", "xyz-long-id-456.jsonl", [
      { type: "system", sessionId: "xyz-long-id-456", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const session = await getClaudeSession("xyz-long", { baseDir: baseDir() });
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("xyz-long-id-456");
  });

  it("returns null for non-existent session", async () => {
    writeTranscript("-proj", "exists.jsonl", [
      { type: "system", sessionId: "exists", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    const session = await getClaudeSession("does-not-exist", { baseDir: baseDir() });
    expect(session).toBeNull();
  });
});
