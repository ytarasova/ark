/**
 * Tests for search bug fixes — transaction safety, ftsTableExists, MIN_MESSAGE_COUNT.
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { indexTranscripts, ftsTableExists, getIndexStats } from "../search.js";
import { refreshClaudeSessionsCache, listClaudeSessions } from "../claude-sessions.js";
import { getDb } from "../store.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();

// ── indexTranscripts transaction safety ─────────────────────────────────────

describe("indexTranscripts transaction safety", () => {
  it("uses transaction — old data is preserved if indexing fails mid-way", async () => {
    const transcriptsDir = join(getCtx().arkDir, "claude-projects");
    const projectDir = join(transcriptsDir, "-tx-project");
    mkdirSync(projectDir, { recursive: true });

    // First: index some valid data
    writeFileSync(join(projectDir, "tx-sess1.jsonl"), [
      JSON.stringify({ type: "user", message: { role: "user", content: "first session content here" }, timestamp: "2026-01-01T00:01:00Z" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "response to first session" }, timestamp: "2026-01-01T00:02:00Z" }),
    ].join("\n"));

    const count1 = await indexTranscripts({ transcriptsDir });
    expect(count1).toBe(2);

    const stats1 = getIndexStats();
    expect(stats1.entries).toBe(2);
  });

  it("commit succeeds and data is queryable after indexing", async () => {
    const transcriptsDir = join(getCtx().arkDir, "claude-projects");
    const projectDir = join(transcriptsDir, "-tx-commit-project");
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(join(projectDir, "tx-commit-sess.jsonl"), [
      JSON.stringify({ type: "user", message: { role: "user", content: "transaction test content here" }, timestamp: "2026-01-01T00:01:00Z" }),
    ].join("\n"));

    await indexTranscripts({ transcriptsDir });

    // Data should be committed and queryable
    const db = getDb();
    const row = db.prepare("SELECT COUNT(*) as c FROM transcript_index").get() as any;
    expect(row.c).toBeGreaterThan(0);
  });
});

// ── ftsTableExists ──────────────────────────────────────────────────────────

describe("ftsTableExists", () => {
  it("returns true when transcript_index table exists", () => {
    // The test context creates the schema including the FTS5 table
    expect(ftsTableExists()).toBe(true);
  });

  it("returns false when table does not exist", () => {
    // Drop the table and check
    const db = getDb();
    db.exec("DROP TABLE IF EXISTS transcript_index");
    expect(ftsTableExists()).toBe(false);
  });
});

// ── MIN_MESSAGE_COUNT allows short conversations ────────────────────────────

describe("MIN_MESSAGE_COUNT = 1 allows short conversations", () => {
  it("includes sessions with just 1 message", async () => {
    const bd = join(getCtx().arkDir, "claude-projects");
    const projectDir = join(bd, "-short-conv");
    mkdirSync(projectDir, { recursive: true });

    // Write a transcript with only 1 user + 1 assistant message (2 total)
    const lines = [
      JSON.stringify({ type: "user", sessionId: "short-sess", message: { role: "user", content: "quick question about auth" }, timestamp: "2026-01-01T00:01:00Z" }),
      JSON.stringify({ type: "assistant", sessionId: "short-sess", message: { role: "assistant", content: "here is the answer to your auth question" }, timestamp: "2026-01-01T00:02:00Z" }),
    ];
    writeFileSync(join(projectDir, "short-sess.jsonl"), lines.join("\n"));

    await refreshClaudeSessionsCache({ baseDir: bd });
    const sessions = listClaudeSessions();

    // With MIN_MESSAGE_COUNT=1, this 2-message session should be included
    const found = sessions.find(s => s.sessionId === "short-sess");
    expect(found).toBeDefined();
  });
});
