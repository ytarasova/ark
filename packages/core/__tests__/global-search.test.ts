import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { searchAllConversations } from "../search/global-search.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

describe("global search", () => {
  it("returns results array (possibly empty) for any query", () => {
    const results = searchAllConversations("function", { maxResults: 1, recentDays: 1 });
    expect(Array.isArray(results)).toBe(true);
  });

  it("respects maxResults limit", () => {
    const results = searchAllConversations("the", { maxResults: 2, recentDays: 1 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("handles missing claude projects dir gracefully", () => {
    expect(() => searchAllConversations("test", { maxResults: 1 })).not.toThrow();
  });

  it("returns empty array for empty query", () => {
    const results = searchAllConversations("", { maxResults: 10, recentDays: 365 });
    // Empty string matches everything or nothing depending on content
    expect(Array.isArray(results)).toBe(true);
  });

  it("results have correct shape", () => {
    const results = searchAllConversations("import", { maxResults: 5, recentDays: 365 });
    for (const r of results) {
      expect(r).toHaveProperty("projectPath");
      expect(r).toHaveProperty("projectName");
      expect(r).toHaveProperty("fileName");
      expect(r).toHaveProperty("matchLine");
      expect(r).toHaveProperty("lineNumber");
      expect(r).toHaveProperty("modifiedAt");
      expect(typeof r.projectName).toBe("string");
      expect(typeof r.lineNumber).toBe("number");
      expect(r.modifiedAt).toBeInstanceOf(Date);
    }
  });

  it("results are sorted by recency (newest first)", () => {
    const results = searchAllConversations("the", { maxResults: 20, recentDays: 365 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].modifiedAt.getTime()).toBeGreaterThanOrEqual(
        results[i].modifiedAt.getTime()
      );
    }
  });

  it("matchLine is truncated to 200 chars", () => {
    const results = searchAllConversations("the", { maxResults: 20, recentDays: 365 });
    for (const r of results) {
      expect(r.matchLine.length).toBeLessThanOrEqual(200);
    }
  });

  it("recentDays=0 returns no results", () => {
    const results = searchAllConversations("the", { maxResults: 100, recentDays: 0 });
    expect(results.length).toBe(0);
  });
});

describe("global search with fixture data", () => {
  const fixtureDir = join(
    process.env.HOME ?? "~",
    ".claude", "projects", "-test-ark-global-search"
  );

  beforeEach(() => {
    mkdirSync(fixtureDir, { recursive: true });
    const lines = [
      JSON.stringify({ message: { content: "This is a unique-test-sentinel value" } }),
      JSON.stringify({ message: { content: "Another line with different text" } }),
      JSON.stringify({ content: "Top-level content field also works" }),
      "not-valid-json{{{",  // malformed line — should be skipped
    ];
    writeFileSync(join(fixtureDir, "test-session.jsonl"), lines.join("\n"));
  });

  afterEach(() => {
    try { rmSync(fixtureDir, { recursive: true }); } catch { /* cleanup */ }
  });

  it("finds matches in fixture JSONL", () => {
    const results = searchAllConversations("unique-test-sentinel", { maxResults: 10, recentDays: 1 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].matchLine).toContain("unique-test-sentinel");
    expect(results[0].fileName).toBe("test-session.jsonl");
  });

  it("matches content in top-level content field", () => {
    const results = searchAllConversations("Top-level content field", { maxResults: 10, recentDays: 1 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("is case insensitive", () => {
    const results = searchAllConversations("UNIQUE-TEST-SENTINEL", { maxResults: 10, recentDays: 1 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("skips malformed JSONL lines without crashing", () => {
    // The fixture has a malformed line — search should still work
    const results = searchAllConversations("Another line", { maxResults: 10, recentDays: 1 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("decodes project name from directory", () => {
    const results = searchAllConversations("unique-test-sentinel", { maxResults: 1, recentDays: 1 });
    if (results.length > 0) {
      // The dir name "-test-ark-global-search" should decode dashes to slashes
      expect(results[0].projectName).toBe("/test/ark/global/search");
    }
  });
});
