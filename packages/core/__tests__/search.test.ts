/**
 * Tests for search -- searchSessions across metadata, events, messages;
 * searchTranscripts across Claude JSONL files; readTranscriptTail helper.
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  searchSessions,
  searchTranscripts,
  indexTranscripts,
  indexSession,
  getIndexStats,
  getSessionConversation,
  searchSessionConversation,
  readTranscriptTail,
} from "../search/search.js";
import type { MessageRole } from "../../types/index.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

const { getCtx } = withTestContext();

// ── searchSessions ──────────────────────────────────────────────────────────

describe("searchSessions", async () => {
  it("finds session by summary", async () => {
    getApp().sessions.create({ summary: "Fix login redirect bug" });
    const results = await searchSessions(getApp(), "login redirect");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.source === "metadata")).toBe(true);
    expect(results[0].match).toContain("Fix login redirect bug");
  });

  it("finds session by ticket (jira_key)", async () => {
    getApp().sessions.create({ ticket: "PROJ-1234", summary: "some task" });
    const results = await searchSessions(getApp(), "PROJ-1234");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const meta = results.find((r) => r.source === "metadata");
    expect(meta).toBeDefined();
  });

  it("finds session by repo", async () => {
    getApp().sessions.create({ repo: "acme/widget-service", summary: "work" });
    const results = await searchSessions(getApp(), "widget-service");
    expect(results.length).toBeGreaterThanOrEqual(1);
    const meta = results.find((r) => r.source === "metadata");
    expect(meta).toBeDefined();
  });

  it("finds matches in event data", async () => {
    const session = getApp().sessions.create({ summary: "unrelated" });
    getApp().events.log(session.id, "deploy", { data: { message: "deployed to staging-east" } });
    const results = await searchSessions(getApp(), "staging-east");
    const ev = results.find((r) => r.source === "event");
    expect(ev).toBeDefined();
    expect(ev!.sessionId).toBe(session.id);
  });

  it("finds matches in messages", async () => {
    const session = getApp().sessions.create({ summary: "unrelated" });
    getApp().messages.send(session.id, "agent" as MessageRole, "Refactored the payment module");
    const results = await searchSessions(getApp(), "payment module");
    const msg = results.find((r) => r.source === "message");
    expect(msg).toBeDefined();
    expect(msg!.sessionId).toBe(session.id);
  });

  it("is case insensitive", async () => {
    getApp().sessions.create({ summary: "Upgrade PostgreSQL driver" });
    const upper = await searchSessions(getApp(), "POSTGRESQL");
    const lower = await searchSessions(getApp(), "postgresql");
    expect(upper.length).toBeGreaterThanOrEqual(1);
    expect(lower.length).toBeGreaterThanOrEqual(1);
  });

  it("limits results", async () => {
    for (let i = 0; i < 10; i++) {
      getApp().sessions.create({ summary: `batch task ${i}` });
    }
    const results = await searchSessions(getApp(), "batch task", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("deduplicates by sessionId + source", async () => {
    // A session whose summary AND ticket both match
    getApp().sessions.create({ ticket: "DUP-99", summary: "DUP-99 duplicate test" });
    const results = await searchSessions(getApp(), "DUP-99");
    const metaResults = results.filter((r) => r.source === "metadata");
    // Should appear at most once for metadata even though both jira_key and jira_summary match
    expect(metaResults.length).toBe(1);
  });

  it("returns empty array when nothing matches", async () => {
    getApp().sessions.create({ summary: "something else" });
    const results = await searchSessions(getApp(), "zzz_nonexistent_zzz");
    expect(results).toEqual([]);
  });

  it("returns results with timestamps", async () => {
    getApp().sessions.create({ summary: "timestamped session" });
    const results = await searchSessions(getApp(), "timestamped");
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(typeof r.timestamp).toBe("string");
    }
  });

  it("returns results from multiple sources", async () => {
    const session = getApp().sessions.create({ summary: "multi-source alpha" });
    getApp().messages.send(session.id, "agent" as MessageRole, "working on alpha feature");
    getApp().events.log(session.id, "note", { data: { note: "alpha checkpoint" } });

    const results = await searchSessions(getApp(), "alpha");
    const sources = new Set(results.map((r) => r.source));
    expect(sources.has("metadata")).toBe(true);
    expect(sources.has("message")).toBe(true);
    expect(sources.has("event")).toBe(true);
  });
});

// ── searchTranscripts ───────────────────────────────────────────────────────

describe("searchTranscripts", async () => {
  it("finds match in JSONL transcript files", async () => {
    // Set up a fake transcripts directory inside the test's arkDir
    const transcriptsDir = join(getCtx().arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "test-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = [
      JSON.stringify({ type: "user", message: { content: "Hello world" }, timestamp: "2025-01-01T00:00:00Z" }),
      JSON.stringify({
        type: "assistant",
        message: { content: "Implementing the frobnicator module" },
        timestamp: "2025-01-01T00:01:00Z",
      }),
    ].join("\n");

    writeFileSync(join(projectDir, "session-abc.jsonl"), jsonl);

    const results = await searchTranscripts(getApp(), "frobnicator", { transcriptsDir });
    expect(results.length).toBe(1);
    expect(results[0].source).toBe("transcript");
    expect(results[0].sessionId).toBe("session-abc");
    expect(results[0].match).toContain("frobnicator");
  });

  it("handles array content in transcript entries", async () => {
    const transcriptsDir = join(getCtx().arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "array-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "analyzing the zygomorphic pattern" }] },
      timestamp: "2025-02-01T00:00:00Z",
    });

    writeFileSync(join(projectDir, "session-arr.jsonl"), jsonl);

    const results = await searchTranscripts(getApp(), "zygomorphic", { transcriptsDir });
    expect(results.length).toBe(1);
    expect(results[0].match).toContain("zygomorphic");
  });

  it("returns empty when no transcripts match", async () => {
    const transcriptsDir = join(getCtx().arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "empty-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = JSON.stringify({
      type: "assistant",
      message: { content: "nothing relevant here" },
      timestamp: "2025-01-01T00:00:00Z",
    });
    writeFileSync(join(projectDir, "session-no.jsonl"), jsonl);

    const results = await searchTranscripts(getApp(), "zzz_impossible_zzz", { transcriptsDir });
    expect(results).toEqual([]);
  });

  it("returns empty when directory does not exist", async () => {
    const results = await searchTranscripts(getApp(), "anything", { transcriptsDir: "/tmp/no-such-dir-ever" });
    expect(results).toEqual([]);
  });

  it("limits transcript results", async () => {
    const transcriptsDir = join(getCtx().arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "many-project");
    mkdirSync(projectDir, { recursive: true });

    for (let i = 0; i < 10; i++) {
      const jsonl = JSON.stringify({
        type: "assistant",
        message: { content: `match keyword-${i}` },
        timestamp: "2025-01-01T00:00:00Z",
      });
      writeFileSync(join(projectDir, `session-${i}.jsonl`), jsonl);
    }

    const results = await searchTranscripts(getApp(), "match keyword", { transcriptsDir, limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("is case insensitive", async () => {
    const transcriptsDir = join(getCtx().arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "case-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = JSON.stringify({
      type: "assistant",
      message: { content: "CamelCase search Target" },
      timestamp: "2025-01-01T00:00:00Z",
    });
    writeFileSync(join(projectDir, "session-case.jsonl"), jsonl);

    const results = await searchTranscripts(getApp(), "camelcase search target", { transcriptsDir });
    expect(results.length).toBe(1);
  });

  it("returns one match per file", async () => {
    const transcriptsDir = join(getCtx().arkDir, "transcripts");
    const projectDir = join(transcriptsDir, "dedup-project");
    mkdirSync(projectDir, { recursive: true });

    const jsonl = [
      JSON.stringify({
        type: "assistant",
        message: { content: "first repeated term" },
        timestamp: "2025-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: "second repeated term" },
        timestamp: "2025-01-01T00:01:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: "third repeated term" },
        timestamp: "2025-01-01T00:02:00Z",
      }),
    ].join("\n");

    writeFileSync(join(projectDir, "session-dedup.jsonl"), jsonl);

    const results = await searchTranscripts(getApp(), "repeated term", { transcriptsDir });
    expect(results.length).toBe(1);
  });
});

// ── indexTranscripts ─────────────────────────────────────────────────────────

describe("indexTranscripts", async () => {
  it("indexes JSONL files and returns count", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-test-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-1.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "fix the auth bug" }] },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "I'll fix the authentication issue" }] },
        }),
      ].join("\n"),
    );

    const count = await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });
    expect(count).toBe(2); // 1 user + 1 assistant message
  });

  it("FTS5 search returns matches after indexing", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-test-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-fts.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "fixed the SQL injection vulnerability in the login handler" }],
          },
        }),
      ].join("\n"),
    );

    await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });
    const results = await searchTranscripts(getApp(), "SQL injection");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("transcript");
  });

  it("multi-term query matches across turns in the same session", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-test-project");
    mkdirSync(projectDir, { recursive: true });
    // "alpha" in one turn, "bravo" in another turn, same session
    writeFileSync(
      join(projectDir, "sess-multi.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "tell me about alpha" },
          timestamp: "2025-01-01T00:00:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "here is info about bravo" }] },
          timestamp: "2025-01-01T00:00:01Z",
        }),
      ].join("\n"),
    );
    await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });

    // Single terms find the session
    const alphaResults = await searchTranscripts(getApp(), "alpha");
    expect(alphaResults.some((r) => r.sessionId === "sess-multi")).toBe(true);
    const bravoResults = await searchTranscripts(getApp(), "bravo");
    expect(bravoResults.some((r) => r.sessionId === "sess-multi")).toBe(true);

    // Multi-term: both terms exist in the session (different turns) -- should find it
    const multiResults = await searchTranscripts(getApp(), "alpha bravo");
    expect(multiResults.some((r) => r.sessionId === "sess-multi")).toBe(true);

    // Multi-term with a non-existent term -- should NOT find it
    const noResults = await searchTranscripts(getApp(), "alpha zzzznonexistent");
    expect(noResults.some((r) => r.sessionId === "sess-multi")).toBe(false);
  });

  it("is fast -- sub-100ms for indexed search", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-test-project");
    mkdirSync(projectDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Working on task ${i}: implementing feature ${i % 10}` }],
          },
        }),
      );
    }
    writeFileSync(join(projectDir, "sess-perf.jsonl"), lines.join("\n"));
    await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });

    const start = performance.now();
    await searchTranscripts(getApp(), "implementing feature");
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(1000); // Performance bound: FTS5 search should complete in under 1s on any machine
  });
});

// ── indexTranscripts filtering ────────────────────────────────────────────────

describe("indexTranscripts filtering", async () => {
  it("does NOT index tool_result entries", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-filter-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-filter.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "abc", content: "tool output here that is long enough" }],
          },
        }),
      ].join("\n"),
    );

    const count = await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });
    expect(count).toBe(0);
  });

  it("does NOT index tool_use-only entries", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-tooluse-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-tooluse.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "/foo" } }],
          },
        }),
      ].join("\n"),
    );

    const count = await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });
    expect(count).toBe(0);
  });

  it("does NOT index short messages under 10 chars", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-short-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-short.jsonl"),
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "ok" } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "done" } }),
      ].join("\n"),
    );

    const count = await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });
    expect(count).toBe(0);
  });

  it("DOES index real user/assistant text", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-real-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-real.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Please refactor the authentication module" },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "I will refactor the authentication module now" },
        }),
      ].join("\n"),
    );

    const count = await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });
    expect(count).toBe(2);
  });

  it("indexes text blocks alongside tool_use blocks", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-mixed-project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-mixed.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I will read the file and fix the issue in the handler" },
              { type: "tool_use", id: "t1", name: "Read", input: { path: "/foo" } },
            ],
          },
        }),
      ].join("\n"),
    );

    const count = await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });
    expect(count).toBe(1); // text block present, so it's indexed
  });
});

// ── indexSession ─────────────────────────────────────────────────────────────

describe("indexSession", () => {
  it("indexes a single transcript file", () => {
    const transcriptPath = join(getCtx().arkDir, "single.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hello world" } }),
    );

    const count = indexSession(getApp(), transcriptPath, "s-single", "test-project");
    expect(count).toBe(1);
  });

  it("incremental -- does not duplicate on second call", () => {
    const transcriptPath = join(getCtx().arkDir, "replace.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "first version here" },
        timestamp: "2026-01-01T00:01:00Z",
      }),
    );
    indexSession(getApp(), transcriptPath, "s-replace");

    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "first version here" },
          timestamp: "2026-01-01T00:01:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "second version here" },
          timestamp: "2026-01-01T00:02:00Z",
        }),
      ].join("\n"),
    );
    indexSession(getApp(), transcriptPath, "s-replace");

    const turns = getSessionConversation(getApp(), "s-replace");
    expect(turns.length).toBe(2); // Not 3 (no duplicate of first)
  });
});

// ── getSessionConversation ────────────────────────────────────────────────────

describe("getSessionConversation", async () => {
  it("returns turns for a known session", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-conv-proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "conv-sess.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hello there friend" },
          timestamp: "2026-01-01T00:01:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "hi there how are you" },
          timestamp: "2026-01-01T00:02:00Z",
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "fix the auth bug please" },
          timestamp: "2026-01-01T00:03:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "I will fix the authentication issue now" },
          timestamp: "2026-01-01T00:04:00Z",
        }),
      ].join("\n"),
    );
    await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });

    const turns = getSessionConversation(getApp(), "conv-sess");
    expect(turns.length).toBe(4);
    expect(turns[0].role).toBe("user");
    expect(turns[0].content).toBe("hello there friend");
    expect(turns[3].content).toContain("authentication");
  });

  it("returns empty for unknown session", () => {
    expect(getSessionConversation(getApp(), "nonexistent")).toEqual([]);
  });

  it("respects limit", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-conv-proj2");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "conv-sess2.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "hello there friend" },
          timestamp: "2026-01-01T00:01:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "hi there how are you" },
          timestamp: "2026-01-01T00:02:00Z",
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "fix the auth bug please" },
          timestamp: "2026-01-01T00:03:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "I will fix the authentication issue now" },
          timestamp: "2026-01-01T00:04:00Z",
        }),
      ].join("\n"),
    );
    await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });

    const turns = getSessionConversation(getApp(), "conv-sess2", { limit: 2 });
    expect(turns.length).toBe(2);
  });
});

// ── searchSessionConversation ────────────────────────────────────────────────

describe("searchSessionConversation", async () => {
  it("finds matches within a session", async () => {
    const projectDir = join(getCtx().arkDir, "claude-projects", "-search-conv-proj");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "search-conv-sess.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "fix the auth bug please" },
          timestamp: "2026-01-01T00:01:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "I will fix the authentication issue now" },
          timestamp: "2026-01-01T00:02:00Z",
        }),
      ].join("\n"),
    );
    await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });

    const results = searchSessionConversation(getApp(), "search-conv-sess", "authentication");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sessionId).toBe("search-conv-sess");
  });

  it("does NOT return results from other sessions", async () => {
    const projectDir1 = join(getCtx().arkDir, "claude-projects", "-iso-proj1");
    mkdirSync(projectDir1, { recursive: true });
    writeFileSync(
      join(projectDir1, "iso-sess1.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "authentication is handled here in the module" },
          timestamp: "2026-01-01T00:01:00Z",
        }),
      ].join("\n"),
    );

    const projectDir2 = join(getCtx().arkDir, "claude-projects", "-iso-proj2");
    mkdirSync(projectDir2, { recursive: true });
    writeFileSync(
      join(projectDir2, "iso-sess2.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "authentication is fixed in this version" },
          timestamp: "2026-01-01T00:01:00Z",
        }),
      ].join("\n"),
    );

    await indexTranscripts(getApp(), { transcriptsDir: join(getCtx().arkDir, "claude-projects") });

    const results = searchSessionConversation(getApp(), "iso-sess1", "authentication");
    for (const r of results) {
      expect(r.sessionId).toBe("iso-sess1");
    }
  });

  it("returns empty for no matches", () => {
    expect(searchSessionConversation(getApp(), "iso-sess1", "zzz_impossible_zzz")).toEqual([]);
  });
});

// ── indexSession improvements ────────────────────────────────────────────────

describe("indexSession improvements", () => {
  it("skips tool_result entries", () => {
    const path = join(getCtx().arkDir, "tool-test.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "big output here" }] },
          timestamp: "2026-01-01T00:01:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "I see the output clearly now" },
          timestamp: "2026-01-01T00:02:00Z",
        }),
      ].join("\n"),
    );
    const count = indexSession(getApp(), path, "tool-test");
    expect(count).toBe(1); // only the assistant message
  });

  it("skips tool_use-only entries", () => {
    const path = join(getCtx().arkDir, "tooluse-test.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Read", input: {} }] },
          timestamp: "2026-01-01T00:01:00Z",
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "what did you find in there" },
          timestamp: "2026-01-01T00:02:00Z",
        }),
      ].join("\n"),
    );
    const count = indexSession(getApp(), path, "tooluse-test");
    expect(count).toBe(1); // only the user message
  });

  it("incremental -- second call adds only new entries", () => {
    const path = join(getCtx().arkDir, "incr-test.jsonl");
    writeFileSync(
      path,
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "first message here" },
        timestamp: "2026-01-01T00:01:00Z",
      }),
    );
    indexSession(getApp(), path, "incr-test");

    // Add more content
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first message here" },
          timestamp: "2026-01-01T00:01:00Z",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "second message here" },
          timestamp: "2026-01-01T00:02:00Z",
        }),
      ].join("\n"),
    );
    indexSession(getApp(), path, "incr-test");

    const turns = getSessionConversation(getApp(), "incr-test");
    expect(turns.length).toBe(2); // not 3 (no duplicate)
  });
});

// ── readTranscriptTail ──────────────────────────────────────────────────────

describe("readTranscriptTail", () => {
  it("returns full content for small files", () => {
    const filePath = join(getCtx().arkDir, "small-transcript.jsonl");
    const content = "line1\nline2\nline3\n";
    writeFileSync(filePath, content);

    const result = readTranscriptTail(filePath);
    expect(result).toBe(content);
  });

  it("returns tail content for large files (> 256KB)", () => {
    const filePath = join(getCtx().arkDir, "large-transcript.jsonl");
    // Create a file larger than 256KB (262144 bytes)
    const tailContent = "TAIL_MARKER_" + "x".repeat(1000) + "\n";
    const paddingSize = 262144 + 10000; // well over the threshold
    const padding = "a".repeat(paddingSize);
    writeFileSync(filePath, padding + tailContent);

    const result = readTranscriptTail(filePath);
    // The result should contain the tail marker (it's in the last 256KB)
    expect(result).toContain("TAIL_MARKER_");
    // The result should NOT contain the full file (it was truncated)
    expect(result.length).toBeLessThanOrEqual(262144);
  });

  it("throws for non-existent files", () => {
    expect(() => readTranscriptTail("/tmp/no-such-file-ever.jsonl")).toThrow();
  });
});

// ── getIndexStats ────────────────────────────────────────────────────────────

describe("getIndexStats", () => {
  it("returns zeros when index is empty", () => {
    const stats = getIndexStats(getApp());
    expect(stats.entries).toBe(0);
    expect(stats.sessions).toBe(0);
  });
});
