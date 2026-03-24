/**
 * Tests for search — searchSessions across metadata, events, messages;
 * searchTranscripts across Claude JSONL files.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../index.js";
import { createSession, logEvent, addMessage } from "../store.js";
import { searchSessions, searchTranscripts, indexTranscripts, indexSession, getIndexStats } from "../search.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

// ── searchSessions ──────────────────────────────────────────────────────────

describe("searchSessions", () => {
  it("finds session by summary", () => {
    createSession({ summary: "Fix login redirect bug" });
    const results = searchSessions("login redirect");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.source === "metadata")).toBe(true);
    expect(results[0].match).toContain("Fix login redirect bug");
  });

  it("finds session by ticket (jira_key)", () => {
    createSession({ ticket: "PROJ-1234", summary: "some task" });
    const results = searchSessions("PROJ-1234");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const meta = results.find(r => r.source === "metadata");
    expect(meta).toBeTruthy();
  });

  it("finds session by repo", () => {
    createSession({ repo: "acme/widget-service", summary: "work" });
    const results = searchSessions("widget-service");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const meta = results.find(r => r.source === "metadata");
    expect(meta).toBeTruthy();
  });

  it("finds matches in event data", () => {
    const session = createSession({ summary: "unrelated" });
    logEvent(session.id, "deploy", { data: { message: "deployed to staging-east" } });
    const results = searchSessions("staging-east");
    const ev = results.find(r => r.source === "event");
    expect(ev).toBeTruthy();
    expect(ev!.sessionId).toBe(session.id);
  });

  it("finds matches in messages", () => {
    const session = createSession({ summary: "unrelated" });
    addMessage({ session_id: session.id, role: "agent", content: "Refactored the payment module" });
    const results = searchSessions("payment module");
    const msg = results.find(r => r.source === "message");
    expect(msg).toBeTruthy();
    expect(msg!.sessionId).toBe(session.id);
  });

  it("is case insensitive", () => {
    createSession({ summary: "Upgrade PostgreSQL driver" });
    const upper = searchSessions("POSTGRESQL");
    const lower = searchSessions("postgresql");
    expect(upper.length).toBeGreaterThanOrEqual(1);
    expect(lower.length).toBeGreaterThanOrEqual(1);
  });

  it("limits results", () => {
    for (let i = 0; i < 10; i++) {
      createSession({ summary: `batch task ${i}` });
    }
    const results = searchSessions("batch task", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("deduplicates by sessionId + source", () => {
    // A session whose summary AND ticket both match
    createSession({ ticket: "DUP-99", summary: "DUP-99 duplicate test" });
    const results = searchSessions("DUP-99");
    const metaResults = results.filter(r => r.source === "metadata");
    // Should appear at most once for metadata even though both jira_key and jira_summary match
    expect(metaResults.length).toBe(1);
  });

  it("returns empty array when nothing matches", () => {
    createSession({ summary: "something else" });
    const results = searchSessions("zzz_nonexistent_zzz");
    expect(results).toEqual([]);
  });

  it("returns results with timestamps", () => {
    createSession({ summary: "timestamped session" });
    const results = searchSessions("timestamped");
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.timestamp).toBeTruthy();
    }
  });

  it("returns results from multiple sources", () => {
    const session = createSession({ summary: "multi-source alpha" });
    addMessage({ session_id: session.id, role: "agent", content: "working on alpha feature" });
    logEvent(session.id, "note", { data: { note: "alpha checkpoint" } });

    const results = searchSessions("alpha");
    const sources = new Set(results.map(r => r.source));
    expect(sources.has("metadata")).toBe(true);
    expect(sources.has("message")).toBe(true);
    expect(sources.has("event")).toBe(true);
  });
});

// ── searchTranscripts ───────────────────────────────────────────────────────

describe("searchTranscripts", () => {
  it("finds match in JSONL transcript files", () => {
    // Set up a fake transcripts directory inside the test's arkDir
    const transcriptsDir = join(ctx.arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "test-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = [
      JSON.stringify({ message: { content: "Hello world" }, timestamp: "2025-01-01T00:00:00Z" }),
      JSON.stringify({ message: { content: "Implementing the frobnicator module" }, timestamp: "2025-01-01T00:01:00Z" }),
    ].join("\n");

    writeFileSync(join(projectDir, "session-abc.jsonl"), jsonl);

    const results = searchTranscripts("frobnicator", { transcriptsDir });
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("transcript");
    expect(results[0].sessionId).toBe("session-abc");
    expect(results[0].match).toContain("frobnicator");
  });

  it("handles array content in transcript entries", () => {
    const transcriptsDir = join(ctx.arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "array-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = JSON.stringify({
      message: { content: [{ type: "text", text: "analyzing the zygomorphic pattern" }] },
      timestamp: "2025-02-01T00:00:00Z",
    });

    writeFileSync(join(projectDir, "session-arr.jsonl"), jsonl);

    const results = searchTranscripts("zygomorphic", { transcriptsDir });
    expect(results.length).toBe(1);
    expect(results[0].match).toContain("zygomorphic");
  });

  it("returns empty when no transcripts match", () => {
    const transcriptsDir = join(ctx.arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "empty-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = JSON.stringify({ message: { content: "nothing relevant here" }, timestamp: "2025-01-01T00:00:00Z" });
    writeFileSync(join(projectDir, "session-no.jsonl"), jsonl);

    const results = searchTranscripts("zzz_impossible_zzz", { transcriptsDir });
    expect(results).toEqual([]);
  });

  it("returns empty when directory does not exist", () => {
    const results = searchTranscripts("anything", { transcriptsDir: "/tmp/no-such-dir-ever" });
    expect(results).toEqual([]);
  });

  it("limits transcript results", () => {
    const transcriptsDir = join(ctx.arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "many-project");
    mkdirSync(projectDir, { recursive: true });

    for (let i = 0; i < 10; i++) {
      const jsonl = JSON.stringify({ message: { content: `match keyword-${i}` }, timestamp: "2025-01-01T00:00:00Z" });
      writeFileSync(join(projectDir, `session-${i}.jsonl`), jsonl);
    }

    const results = searchTranscripts("match keyword", { transcriptsDir, limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("is case insensitive", () => {
    const transcriptsDir = join(ctx.arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "case-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = JSON.stringify({ message: { content: "CamelCase search Target" }, timestamp: "2025-01-01T00:00:00Z" });
    writeFileSync(join(projectDir, "session-case.jsonl"), jsonl);

    const results = searchTranscripts("camelcase search target", { transcriptsDir });
    expect(results.length).toBe(1);
  });

  it("returns one match per file", () => {
    const transcriptsDir = join(ctx.arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "dedup-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = [
      JSON.stringify({ message: { content: "first repeated term" }, timestamp: "2025-01-01T00:00:00Z" }),
      JSON.stringify({ message: { content: "second repeated term" }, timestamp: "2025-01-01T00:01:00Z" }),
      JSON.stringify({ message: { content: "third repeated term" }, timestamp: "2025-01-01T00:02:00Z" }),
    ].join("\n");

    writeFileSync(join(projectDir, "session-dedup.jsonl"), jsonl);

    const results = searchTranscripts("repeated term", { transcriptsDir });
    expect(results.length).toBe(1);
  });
});

// ── indexTranscripts ─────────────────────────────────────────────────────────

describe("indexTranscripts", () => {
  it("indexes JSONL files and returns count", async () => {
    const projectDir = join(ctx.arkDir, "claude-projects", "-test-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "sess-1.jsonl"), [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "fix the auth bug" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I'll fix the authentication issue" }] } }),
    ].join("\n"));

    const count = await indexTranscripts({ transcriptsDir: join(ctx.arkDir, "claude-projects") });
    expect(count).toBe(2); // 1 user + 1 assistant message
  });

  it("FTS5 search returns matches after indexing", async () => {
    const projectDir = join(ctx.arkDir, "claude-projects", "-test-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "sess-fts.jsonl"), [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "fixed the SQL injection vulnerability in the login handler" }] } }),
    ].join("\n"));

    await indexTranscripts({ transcriptsDir: join(ctx.arkDir, "claude-projects") });
    const results = searchTranscripts("SQL injection");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("transcript");
  });

  it("is fast — sub-100ms for indexed search", async () => {
    const projectDir = join(ctx.arkDir, "claude-projects", "-test-project");
    mkdirSync(projectDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `Working on task ${i}: implementing feature ${i % 10}` }] } }));
    }
    writeFileSync(join(projectDir, "sess-perf.jsonl"), lines.join("\n"));
    await indexTranscripts({ transcriptsDir: join(ctx.arkDir, "claude-projects") });

    const start = performance.now();
    searchTranscripts("implementing feature");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

// ── indexSession ─────────────────────────────────────────────────────────────

describe("indexSession", () => {
  it("indexes a single transcript file", () => {
    const transcriptPath = join(ctx.arkDir, "single.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hello world" } }));

    const count = indexSession(transcriptPath, "s-single", "test-project");
    expect(count).toBe(1);
  });

  it("replaces existing entries for same session", () => {
    const transcriptPath = join(ctx.arkDir, "replace.jsonl");
    writeFileSync(transcriptPath, JSON.stringify({ type: "assistant", message: { role: "assistant", content: "first version" } }));
    indexSession(transcriptPath, "s-replace");

    writeFileSync(transcriptPath, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "first version" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "second version" } }),
    ].join("\n"));
    indexSession(transcriptPath, "s-replace");

    const stats = getIndexStats();
    expect(stats.entries).toBe(2); // Not 3 (1 old + 2 new)
  });
});

// ── getIndexStats ────────────────────────────────────────────────────────────

describe("getIndexStats", () => {
  it("returns zeros when index is empty", () => {
    const stats = getIndexStats();
    expect(stats.entries).toBe(0);
    expect(stats.sessions).toBe(0);
  });
});
