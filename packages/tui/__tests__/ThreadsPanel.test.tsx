import { describe, it, expect } from "bun:test";
import { extractMentionPrefix, filterSessionCompletions } from "../components/ThreadsPanel.js";
import type { Session } from "../../core/index.js";

function makeSession(id: string, summary: string | null, status = "running"): Session {
  return {
    id,
    ticket: null,
    summary,
    repo: null,
    branch: null,
    compute_name: null,
    session_id: null,
    claude_session_id: null,
    stage: null,
    status,
    flow: "default",
    agent: null,
    workdir: null,
    pr_url: null,
    pr_id: null,
    error: null,
    parent_id: null,
    fork_group: null,
    group_name: null,
    breakpoint_reason: null,
    attached_by: null,
    config: {},
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("extractMentionPrefix", () => {
  it("returns null for empty string", () => {
    expect(extractMentionPrefix("")).toBe(null);
  });

  it("returns null for plain text", () => {
    expect(extractMentionPrefix("hello")).toBe(null);
  });

  it("returns null for @ in the middle of text", () => {
    expect(extractMentionPrefix("hello @world")).toBe(null);
  });

  it("returns null when @ is followed by a space (completed mention + message)", () => {
    expect(extractMentionPrefix("@session hello")).toBe(null);
  });

  it("returns empty string for bare @", () => {
    expect(extractMentionPrefix("@")).toBe("");
  });

  it("returns prefix after @", () => {
    expect(extractMentionPrefix("@ses")).toBe("ses");
  });

  it("returns full word for @session-name", () => {
    expect(extractMentionPrefix("@my-session")).toBe("my-session");
  });
});

describe("filterSessionCompletions", () => {
  const sessions = [
    makeSession("s-abc123", "fix-login-bug"),
    makeSession("s-def456", "add-search-feature"),
    makeSession("s-ghi789", null), // uses id as name
  ];

  it("returns all sessions for empty prefix", () => {
    const results = filterSessionCompletions(sessions, "");
    expect(results).toHaveLength(3);
  });

  it("filters by session name prefix", () => {
    const results = filterSessionCompletions(sessions, "fix");
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("fix-login-bug");
    expect(results[0].id).toBe("s-abc123");
  });

  it("filters by session id prefix", () => {
    const results = filterSessionCompletions(sessions, "s-def");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("s-def456");
  });

  it("is case-insensitive", () => {
    const results = filterSessionCompletions(sessions, "FIX");
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("fix-login-bug");
  });

  it("returns empty array when nothing matches", () => {
    const results = filterSessionCompletions(sessions, "zzz");
    expect(results).toHaveLength(0);
  });

  it("matches sessions without summary by their id", () => {
    const results = filterSessionCompletions(sessions, "s-ghi");
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("s-ghi789");
  });

  it("matches add prefix to add-search-feature", () => {
    const results = filterSessionCompletions(sessions, "add");
    expect(results).toHaveLength(1);
    expect(results[0].label).toBe("add-search-feature");
  });
});
