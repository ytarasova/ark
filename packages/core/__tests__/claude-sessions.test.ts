/**
 * Tests for Claude Code session discovery — listClaudeSessions, getClaudeSession.
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, utimesSync } from "fs";
import { join } from "path";
import { listClaudeSessions, getClaudeSession, refreshClaudeSessionsCache } from "../claude-sessions.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();

function baseDir() {
  return join(getCtx().arkDir, "claude-projects");
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

// ── incremental refresh ─────────────────────────────────────────────────────

describe("incremental refresh", () => {
  it("skips unmodified files on second refresh (returns 0 new)", async () => {
    writeTranscript("-incr-proj", "sess-incr.jsonl", [
      { type: "system", sessionId: "sess-incr", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: "first pass" }, timestamp: "2026-03-24T10:01:00Z" },
    ]);

    const first = await refreshClaudeSessionsCache({ baseDir: baseDir() });
    expect(first).toBeGreaterThanOrEqual(1);

    // Second refresh with no file changes — should return 0 new entries
    const second = await refreshClaudeSessionsCache({ baseDir: baseDir() });
    expect(second).toBe(0);
  });

  it("picks up new files added after first refresh", async () => {
    writeTranscript("-incr2-proj", "existing.jsonl", [
      { type: "system", sessionId: "existing", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: "old session" }, timestamp: "2026-03-24T10:01:00Z" },
    ]);

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const before = listClaudeSessions();
    const countBefore = before.length;

    // Set explicit future mtime to guarantee incremental refresh detects the new file
    // (avoids flaky 50ms sleep that fails on filesystems with 1s mtime granularity)
    writeTranscript("-incr2-proj", "brand-new.jsonl", [
      { type: "system", sessionId: "brand-new", timestamp: "2026-03-24T11:00:00Z" },
      { type: "user", message: { role: "user", content: "new session" }, timestamp: "2026-03-24T11:01:00Z" },
    ]);
    const futureTime = new Date(Date.now() + 2000);
    utimesSync(join(baseDir(), "-incr2-proj", "brand-new.jsonl"), futureTime, futureTime);

    const added = await refreshClaudeSessionsCache({ baseDir: baseDir() });
    expect(added).toBeGreaterThanOrEqual(1);

    const after = listClaudeSessions();
    expect(after.length).toBeGreaterThan(countBefore);
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

// ── Filtering ────────────────────────────────────────────────────────────────

describe("claude sessions filtering", () => {
  it("sessions with <10 messages are filtered out", async () => {
    // Write a session with only 4 user+assistant messages (8 total lines with system)
    const fewMsgs: object[] = [
      { type: "system", sessionId: "few-msgs", timestamp: "2026-03-24T10:00:00Z" },
    ];
    for (let i = 0; i < 4; i++) {
      fewMsgs.push(
        { type: "user", message: { role: "user", content: `q${i}: ${"x".repeat(500)}` }, timestamp: `2026-03-24T10:0${i + 1}:00Z` },
        { type: "assistant", message: { role: "assistant", content: `a${i}: ${"y".repeat(500)}` }, timestamp: `2026-03-24T10:0${i + 1}:30Z` },
      );
    }
    const dir = join(baseDir(), "-filter-few");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "few-msgs.jsonl"), fewMsgs.map(l => JSON.stringify(l)).join("\n"));

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    const found = sessions.find(s => s.sessionId === "few-msgs");
    expect(found).toBeUndefined();
  });

  it("sessions with >=10 messages are included", async () => {
    await writeAndRefresh("-filter-many", "many-msgs.jsonl", [
      { type: "system", sessionId: "many-msgs", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: "hello" }, timestamp: "2026-03-24T10:01:00Z" },
    ]);

    const sessions = listClaudeSessions();
    const found = sessions.find(s => s.sessionId === "many-msgs");
    expect(found).toBeTruthy();
    expect(found!.messageCount).toBeGreaterThanOrEqual(10);
  });

  it("sessions from /var/folders/ paths are filtered", async () => {
    // Write a transcript under a dir name that decodes to /var/folders/...
    const varFolderDir = join(baseDir(), "-var-folders-ab-cd-T-test");
    mkdirSync(varFolderDir, { recursive: true });
    const msgs: object[] = [
      { type: "system", sessionId: "var-folder-session", timestamp: "2026-03-24T10:00:00Z" },
    ];
    // Add enough messages to pass the 10+ filter
    for (let i = 0; i < 12; i++) {
      msgs.push(
        { type: "user", message: { role: "user", content: `q${i}: ${"x".repeat(500)}` }, timestamp: `2026-03-24T10:${String(i + 1).padStart(2, "0")}:00Z` },
        { type: "assistant", message: { role: "assistant", content: `a${i}: ${"y".repeat(500)}` }, timestamp: `2026-03-24T10:${String(i + 1).padStart(2, "0")}:30Z` },
      );
    }
    writeFileSync(join(varFolderDir, "var-folder-session.jsonl"), msgs.map(l => JSON.stringify(l)).join("\n"));

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    const found = sessions.find(s => s.sessionId === "var-folder-session");
    expect(found).toBeUndefined();
  });

  it("sessions from /worktrees/ paths are filtered", async () => {
    // Write a transcript under a dir name that decodes to .../worktrees/...
    const worktreeDir = join(baseDir(), "-Users-yana-.ark-worktrees-s-abc123");
    mkdirSync(worktreeDir, { recursive: true });
    const msgs: object[] = [
      { type: "system", sessionId: "worktree-session", timestamp: "2026-03-24T10:00:00Z" },
    ];
    for (let i = 0; i < 12; i++) {
      msgs.push(
        { type: "user", message: { role: "user", content: `q${i}: ${"x".repeat(500)}` }, timestamp: `2026-03-24T10:${String(i + 1).padStart(2, "0")}:00Z` },
        { type: "assistant", message: { role: "assistant", content: `a${i}: ${"y".repeat(500)}` }, timestamp: `2026-03-24T10:${String(i + 1).padStart(2, "0")}:30Z` },
      );
    }
    writeFileSync(join(worktreeDir, "worktree-session.jsonl"), msgs.map(l => JSON.stringify(l)).join("\n"));

    await refreshClaudeSessionsCache({ baseDir: baseDir() });
    const sessions = listClaudeSessions();
    const found = sessions.find(s => s.sessionId === "worktree-session");
    expect(found).toBeUndefined();
  });

  it("full refresh then incremental refresh flow", async () => {
    // Write first file
    writeTranscript("-refresh-flow", "first.jsonl", [
      { type: "system", sessionId: "first-session", timestamp: "2026-03-24T10:00:00Z" },
      { type: "user", message: { role: "user", content: "first task" }, timestamp: "2026-03-24T10:01:00Z" },
    ]);

    // Full refresh
    const firstCount = await refreshClaudeSessionsCache({ baseDir: baseDir() });
    expect(firstCount).toBeGreaterThanOrEqual(1);

    // Verify cache has the session
    let sessions = listClaudeSessions();
    expect(sessions.find(s => s.sessionId === "first-session")).toBeTruthy();

    // Second refresh with no changes - incremental should return 0
    const secondCount = await refreshClaudeSessionsCache({ baseDir: baseDir() });
    expect(secondCount).toBe(0);

    // Set explicit future mtime to guarantee incremental refresh detects the new file
    // (avoids flaky 50ms sleep that fails on filesystems with 1s mtime granularity)

    // Write a second file and refresh incrementally
    writeTranscript("-refresh-flow", "second.jsonl", [
      { type: "system", sessionId: "second-session", timestamp: "2026-03-24T11:00:00Z" },
      { type: "user", message: { role: "user", content: "second task" }, timestamp: "2026-03-24T11:01:00Z" },
    ]);
    const futureTime2 = new Date(Date.now() + 2000);
    utimesSync(join(baseDir(), "-refresh-flow", "second.jsonl"), futureTime2, futureTime2);

    const thirdCount = await refreshClaudeSessionsCache({ baseDir: baseDir() });
    expect(thirdCount).toBeGreaterThanOrEqual(1);

    // Both sessions should now be in cache
    sessions = listClaudeSessions();
    expect(sessions.find(s => s.sessionId === "first-session")).toBeTruthy();
    expect(sessions.find(s => s.sessionId === "second-session")).toBeTruthy();
  });
});
