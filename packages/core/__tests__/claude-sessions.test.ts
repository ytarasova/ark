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
import { listClaudeSessions, getClaudeSession, refreshClaudeSessionsCache } from "../claude-sessions.js";

let ctx: TestContext;

function baseDir() {
  return join(ctx.arkDir, "claude-projects");
}

/** Padding messages to pass the >=10 message + 10KB size filter */
const MIN_MSGS: object[] = [];
for (let i = 0; i < 12; i++) {
  MIN_MSGS.push(
    { type: "user", message: { role: "user", content: `Question ${i}: ${"x".repeat(500)}` }, timestamp: `2026-03-24T10:00:${String(i * 2 + 1).padStart(2, "0")}Z` },
    { type: "assistant", message: { role: "assistant", content: `Answer ${i}: ${"y".repeat(500)}` }, timestamp: `2026-03-24T10:00:${String(i * 2 + 2).padStart(2, "0")}Z` },
  );
}

/** Write a fake JSONL transcript. Pads to >=10 messages + 10KB if needed. */
function writeTranscript(projectDirName: string, filename: string, lines: object[]) {
  const dir = join(baseDir(), projectDirName);
  mkdirSync(dir, { recursive: true });
  const msgCount = lines.filter((l: any) => l.type === "user" || l.type === "assistant").length;
  const allLines = msgCount >= 10 ? lines : [...lines, ...MIN_MSGS];
  writeFileSync(join(dir, filename), allLines.map(l => JSON.stringify(l)).join("\n"));
}

/** Write transcripts and refresh the cache so listClaudeSessions can read them */
async function writeAndRefresh(projectDirName: string, filename: string, lines: object[]) {
  writeTranscript(projectDirName, filename, lines);
  await refreshClaudeSessionsCache({ baseDir: baseDir() });
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
    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    expect(sessions).toEqual([]);
  });

  it("returns empty array for an empty directory", async () => {
    mkdirSync(baseDir(), { recursive: true });
    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    expect(sessions).toEqual([]);
  });

  it("discovers sessions from JSONL files with correct metadata", async () => {
    const msgs: object[] = [
      { type: "system", sessionId: "abc-123", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "fix the bug" }] }, timestamp: "2026-03-24T10:01:00Z" },
    ];
    // Add enough messages to pass the 10+ filter
    for (let i = 0; i < 10; i++) {
      msgs.push({ type: "assistant", message: { role: "assistant", content: `step ${i}` }, timestamp: `2026-03-24T10:${String(i + 2).padStart(2, "0")}:00Z` });
      msgs.push({ type: "user", message: { role: "user", content: `next ${i}` }, timestamp: `2026-03-24T10:${String(i + 2).padStart(2, "0")}:30Z` });
    }
    writeTranscript("-Users-yana-Projects-ark", "abc-123.jsonl", msgs);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    expect(sessions.length).toBe(1);

    const s = sessions[0];
    expect(s.sessionId).toBe("abc-123");
    expect(s.summary).toBe("fix the bug");
    expect(s.messageCount).toBeGreaterThanOrEqual(10);
    expect(s.transcriptPath).toContain("abc-123.jsonl");
  });

  it("decodes project path from directory name", async () => {
    writeTranscript("-Users-yana-Projects-ark", "s1.jsonl", [
      { type: "system", sessionId: "s1", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    expect(sessions[0].project).toBe("/Users/yana/Projects/ark");
    expect(sessions[0].projectDir).toBe("-Users-yana-Projects-ark");
  });

  it("counts only user and assistant messages, not system", async () => {
    const msgs: object[] = [
      { type: "system", sessionId: "s2", timestamp: "2026-01-01T00:00:00Z" },
    ];
    // 6 user + 5 assistant = 11 messages, plus 3 system = 14 lines
    for (let i = 0; i < 6; i++) {
      msgs.push({ type: "user", message: { role: "user", content: `q${i}` }, timestamp: `2026-01-01T00:${String(i + 1).padStart(2, "0")}:00Z` });
      if (i < 5) msgs.push({ type: "assistant", message: { role: "assistant", content: `a${i}` }, timestamp: `2026-01-01T00:${String(i + 1).padStart(2, "0")}:30Z` });
    }
    msgs.push({ type: "system", content: "ignored1" });
    msgs.push({ type: "system", content: "ignored2" });
    writeTranscript("-test-proj", "s2.jsonl", msgs);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    expect(sessions[0].messageCount).toBe(11); // 6 user + 5 assistant, system excluded
  });

  it("extracts summary from string content", async () => {
    writeTranscript("-str-proj", "s3.jsonl", [
      { type: "user", message: { role: "user", content: "refactor the auth module" }, timestamp: "2026-01-01T00:00:00Z" },
    ]);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    expect(sessions[0].summary).toBe("refactor the auth module");
  });

  it("extracts summary from array content", async () => {
    writeTranscript("-arr-proj", "s4.jsonl", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "deploy to staging" }] }, timestamp: "2026-01-01T00:00:00Z" },
    ]);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    expect(sessions[0].summary).toBe("deploy to staging");
  });

  it("sorts by most recent activity first", async () => {
    // Build 10+ message sessions with distinct timestamp ranges
    const oldMsgs: object[] = [{ type: "system", sessionId: "old", timestamp: "2020-01-01T00:00:00Z" }];
    for (let i = 0; i < 6; i++) {
      oldMsgs.push({ type: "user", message: { role: "user", content: `old q${i}` }, timestamp: `2020-01-01T0${i + 1}:00:00Z` });
      oldMsgs.push({ type: "assistant", message: { role: "assistant", content: `old a${i}` }, timestamp: `2020-01-01T0${i + 1}:30:00Z` });
    }
    const newMsgs: object[] = [{ type: "system", sessionId: "new", timestamp: "2029-01-01T00:00:00Z" }];
    for (let i = 0; i < 6; i++) {
      newMsgs.push({ type: "user", message: { role: "user", content: `new q${i}` }, timestamp: `2029-01-01T0${i + 1}:00:00Z` });
      newMsgs.push({ type: "assistant", message: { role: "assistant", content: `new a${i}` }, timestamp: `2029-01-01T0${i + 1}:30:00Z` });
    }
    writeTranscript("-proj-a", "old.jsonl", oldMsgs);
    writeTranscript("-proj-b", "new.jsonl", newMsgs);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
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

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
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

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions({ limit: 3 });
    expect(sessions.length).toBe(3);
  });

  it("filters by project name", async () => {
    writeTranscript("-Users-yana-Projects-ark", "ark-s.jsonl", [
      { type: "system", sessionId: "ark-s", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    writeTranscript("-Users-yana-Projects-other", "other-s.jsonl", [
      { type: "system", sessionId: "other-s", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions({ project: "ark" });
    expect(sessions.length).toBe(1);
    expect(sessions[0].sessionId).toBe("ark-s");
  });

  it("skips empty JSONL files", async () => {
    const dir = join(baseDir(), "-empty-proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "empty.jsonl"), "");

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    expect(sessions).toEqual([]);
  });

  it("strips HTML tags from summary", async () => {
    writeTranscript("-html-proj", "html-s.jsonl", [
      { type: "user", message: { role: "user", content: "<context>some xml</context> fix this" }, timestamp: "2026-01-01T00:00:00Z" },
    ]);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
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

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const session = getClaudeSession("abc-def-123", { baseDir: baseDir() });
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("abc-def-123");
    expect(session!.summary).toBe("found it");
  });

  it("finds session by prefix", async () => {
    writeTranscript("-proj", "xyz-long-id-456.jsonl", [
      { type: "system", sessionId: "xyz-long-id-456", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const session = getClaudeSession("xyz-long", { baseDir: baseDir() });
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe("xyz-long-id-456");
  });

  it("returns null for non-existent session", async () => {
    writeTranscript("-proj", "exists.jsonl", [
      { type: "system", sessionId: "exists", timestamp: "2026-01-01T00:00:00Z" },
    ]);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const session = getClaudeSession("does-not-exist", { baseDir: baseDir() });
    expect(session).toBeNull();
  });
});
