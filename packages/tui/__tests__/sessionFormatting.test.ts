/**
 * Tests for sessionFormatting — pure helpers for session detail pane.
 */

import { describe, it, expect } from "bun:test";
import {
  formatTokenDisplay,
  buildFileLinks,
  buildCommitLinks,
  stripAnsiAndFilter,
  formatDuration,
  getColumnWidths,
  fitText,
  shortId,
  sessionLabel,
  formatSessionRow,
  formatChildRow,
} from "../helpers/sessionFormatting.js";
import type { Session } from "../../types/index.js";

describe("formatTokenDisplay", () => {
  it("returns null for missing totals or zero tokens", () => {
    expect(formatTokenDisplay(null)).toBeNull();
    expect(formatTokenDisplay({ total_tokens: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 })).toBeNull();
  });

  it("formats tokens correctly", () => {
    const result = formatTokenDisplay({
      total_tokens: 150000,
      input_tokens: 100000,
      output_tokens: 50000,
      cache_read_tokens: 80000,
    })!;
    expect(result).toContain("150.0K");
    expect(result).toContain("in:100.0K");
    expect(result).toContain("out:50.0K");
    expect(result).toContain("cache:80.0K");
  });

  it("handles zero cache tokens", () => {
    const result = formatTokenDisplay({
      total_tokens: 5000,
      input_tokens: 3000,
      output_tokens: 2000,
      cache_read_tokens: 0,
    })!;
    expect(result).toContain("5.0K");
    expect(result).toContain("cache:0");
  });

  it("handles large token counts", () => {
    const result = formatTokenDisplay({
      total_tokens: 2500000,
      input_tokens: 2000000,
      output_tokens: 500000,
      cache_read_tokens: 1500000,
    })!;
    expect(result).toContain("2.5M");
    expect(result).toContain("in:2.0M");
  });
});

describe("buildFileLinks", () => {
  it("returns null when no events / no files", () => {
    expect(buildFileLinks({})).toBeNull();
    expect(buildFileLinks({ config: {} })).toBeNull();
    expect(buildFileLinks({ config: { filesChanged: [] } })).toBeNull();
  });

  it("returns correct paths and URLs with github base", () => {
    const session = {
      config: {
        filesChanged: ["src/index.ts", "README.md"],
        github_url: "https://github.com/user/repo",
      },
    };
    const links = buildFileLinks(session)!;
    expect(links).toHaveLength(2);
    expect(links[0].path).toBe("src/index.ts");
    expect(links[0].url).toBe("https://github.com/user/repo/blob/main/src/index.ts");
    expect(links[1].path).toBe("README.md");
    expect(links[1].url).toBe("https://github.com/user/repo/blob/main/README.md");
  });

  it("returns null URLs when no github_url", () => {
    const session = {
      config: {
        filesChanged: ["src/app.ts"],
      },
    };
    const links = buildFileLinks(session)!;
    expect(links).toHaveLength(1);
    expect(links[0].path).toBe("src/app.ts");
    expect(links[0].url).toBeNull();
  });
});

describe("buildCommitLinks", () => {
  it("returns null when no events / no commits", () => {
    expect(buildCommitLinks({})).toBeNull();
    expect(buildCommitLinks({ config: {} })).toBeNull();
    expect(buildCommitLinks({ config: { commits: [] } })).toBeNull();
  });

  it("returns correct sha/shortSha/url", () => {
    const sha = "abc1234def5678901234567890abcdef12345678";
    const session = {
      config: {
        commits: [sha],
        github_url: "https://github.com/user/repo",
      },
    };
    const links = buildCommitLinks(session)!;
    expect(links).toHaveLength(1);
    expect(links[0].sha).toBe(sha);
    expect(links[0].shortSha).toBe("abc1234");
    expect(links[0].url).toBe(`https://github.com/user/repo/commit/${sha}`);
  });

  it("returns null URLs when no github_url", () => {
    const sha = "deadbeef12345678901234567890abcdef123456";
    const session = {
      config: {
        commits: [sha],
      },
    };
    const links = buildCommitLinks(session)!;
    expect(links[0].url).toBeNull();
    expect(links[0].shortSha).toBe("deadbee");
  });

  it("handles multiple commits", () => {
    const session = {
      config: {
        commits: ["aaa1111222233334444555566667777888899990000", "bbb1111222233334444555566667777888899990000"],
        github_url: "https://github.com/user/repo",
      },
    };
    const links = buildCommitLinks(session)!;
    expect(links).toHaveLength(2);
    expect(links[0].shortSha).toBe("aaa1111");
    expect(links[1].shortSha).toBe("bbb1111");
  });
});

describe("stripAnsiAndFilter", () => {
  it("strips ANSI codes", () => {
    const input = "\x1b[32mhello\x1b[0m world";
    const result = stripAnsiAndFilter(input);
    expect(result).toEqual(["hello world"]);
  });

  it("filters blank lines", () => {
    const input = "line1\n\n  \n\nline2";
    const result = stripAnsiAndFilter(input);
    expect(result).toEqual(["line1", "line2"]);
  });

  it("returns last N lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const result = stripAnsiAndFilter(lines, 5);
    expect(result).toHaveLength(5);
    expect(result[0]).toBe("line16");
    expect(result[4]).toBe("line20");
  });

  it("defaults to last 12 lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
    const result = stripAnsiAndFilter(lines);
    expect(result).toHaveLength(12);
    expect(result[0]).toBe("line9");
    expect(result[11]).toBe("line20");
  });

  it("strips control characters", () => {
    const input = "hello\x07world\x08test";
    const result = stripAnsiAndFilter(input);
    expect(result).toEqual(["helloworldtest"]);
  });

  it("handles empty input", () => {
    expect(stripAnsiAndFilter("")).toEqual([]);
    expect(stripAnsiAndFilter("  \n  \n  ")).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("returns empty string for null input", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(null, null)).toBe("");
  });

  it("returns empty string for invalid date", () => {
    expect(formatDuration("not-a-date")).toBe("");
  });

  it("formats seconds", () => {
    const from = new Date(Date.now() - 30_000).toISOString();
    const result = formatDuration(from);
    expect(result).toBe("30s");
  });

  it("formats minutes and seconds", () => {
    const from = new Date(Date.now() - 125_000).toISOString(); // 2m 5s
    const result = formatDuration(from);
    expect(result).toBe("2m 5s");
  });

  it("formats hours and minutes", () => {
    const from = new Date(Date.now() - 3_900_000).toISOString(); // 1h 5m
    const result = formatDuration(from);
    expect(result).toBe("1h 5m");
  });

  it("formats days and hours", () => {
    const from = new Date(Date.now() - 90_000_000).toISOString(); // 1d 1h
    const result = formatDuration(from);
    expect(result).toBe("1d 1h");
  });

  it("formats duration between two timestamps", () => {
    const from = "2026-01-01T00:00:00Z";
    const to = "2026-01-01T01:30:00Z"; // 1h 30m
    const result = formatDuration(from, to);
    expect(result).toBe("1h 30m");
  });

  it("handles zero duration", () => {
    const now = new Date().toISOString();
    const result = formatDuration(now, now);
    expect(result).toBe("0s");
  });
});

// ── Session list row formatting ─────────────────────────────────────────────

describe("getColumnWidths", () => {
  it("returns wide columns for large terminals", () => {
    const w = getColumnWidths(160);
    expect(w.summary).toBe(42);
    expect(w.id).toBe(8);
    expect(w.stage).toBe(12);
  });

  it("returns medium columns for mid-size terminals", () => {
    const w = getColumnWidths(120);
    expect(w.summary).toBe(28);
    expect(w.id).toBe(8);
    expect(w.stage).toBe(10);
  });

  it("returns narrow columns for small terminals", () => {
    const w = getColumnWidths(80);
    expect(w.summary).toBe(20);
    expect(w.id).toBe(0);
    expect(w.stage).toBe(0);
  });
});

describe("fitText", () => {
  it("pads short text to width", () => {
    expect(fitText("hello", 10)).toBe("hello     ");
  });

  it("truncates long text with ellipsis", () => {
    const result = fitText("a very long summary text", 10);
    expect(result.length).toBe(10);
    expect(result).toBe("a very lo\u2026");
  });

  it("returns exact text when equal to width", () => {
    expect(fitText("12345", 5)).toBe("12345");
  });

  it("returns empty string when width is 0", () => {
    expect(fitText("anything", 0)).toBe("");
  });
});

describe("shortId", () => {
  it("strips s- prefix and truncates to 6 chars", () => {
    expect(shortId("s-abc123def")).toBe("abc123");
  });

  it("handles short IDs", () => {
    expect(shortId("s-ab")).toBe("ab");
  });

  it("handles IDs without prefix", () => {
    expect(shortId("xyz789abc")).toBe("xyz789");
  });
});

describe("sessionLabel", () => {
  it("returns summary when available", () => {
    expect(sessionLabel({ summary: "Fix bug", ticket: "T-1", repo: "/repo" })).toBe("Fix bug");
  });

  it("falls back to ticket", () => {
    expect(sessionLabel({ summary: null, ticket: "JIRA-123", repo: "/repo" })).toBe("JIRA-123");
  });

  it("falls back to repo", () => {
    expect(sessionLabel({ summary: null, ticket: null, repo: "/my/repo" })).toBe("/my/repo");
  });

  it("returns placeholder when all null", () => {
    expect(sessionLabel({ summary: null, ticket: null, repo: null })).toBe("(no summary)");
  });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-abc123",
    ticket: null,
    summary: "Fix a bug",
    repo: "/repo",
    branch: "main",
    compute_name: null,
    session_id: null,
    claude_session_id: null,
    stage: "implement",
    status: "running",
    flow: "default",
    agent: "implementer",
    workdir: "/repo",
    pr_url: null,
    pr_id: null,
    error: null,
    parent_id: null,
    fork_group: null,
    group_name: null,
    breakpoint_reason: null,
    attached_by: null,
    config: {},
    user_id: null,
    tenant_id: "default",
    created_at: new Date(Date.now() - 300000).toISOString(), // 5m ago
    updated_at: new Date(Date.now() - 60000).toISOString(),  // 1m ago
    ...overrides,
  };
}

describe("formatSessionRow", () => {
  it("includes icon, summary, id, stage, and age", () => {
    const row = formatSessionRow(makeSession(), 120, 0);
    expect(row).toContain("\u25CF"); // running icon
    expect(row).toContain("Fix a bug");
    expect(row).toContain("abc123");
    expect(row).toContain("implement");
  });

  it("includes unread badge when count > 0", () => {
    const row = formatSessionRow(makeSession(), 120, 3);
    expect(row).toContain("(3)");
  });

  it("omits unread badge when count is 0", () => {
    const row = formatSessionRow(makeSession(), 120, 0);
    expect(row).not.toContain("(0)");
  });

  it("uses updated_at for age", () => {
    const s = makeSession({
      created_at: new Date(Date.now() - 86400000).toISOString(), // 1d ago
      updated_at: new Date(Date.now() - 120000).toISOString(),   // 2m ago
    });
    const row = formatSessionRow(s, 120, 0);
    expect(row).toContain("2m");
    expect(row).not.toContain("1d");
  });

  it("hides id and stage columns on narrow terminals", () => {
    const row = formatSessionRow(makeSession(), 80, 0);
    expect(row).not.toContain("abc123");
  });
});

describe("formatChildRow", () => {
  it("includes icon, label, and age", () => {
    const child = makeSession({ summary: "Child task", status: "completed" });
    const row = formatChildRow(child);
    expect(row).toContain("\u2714"); // completed icon
    expect(row).toContain("Child task");
  });

  it("truncates long child summaries", () => {
    const child = makeSession({ summary: "A very long child summary that should be truncated at 24 chars" });
    const row = formatChildRow(child);
    // Summary should be at most 24 chars
    expect(row.indexOf("A very long child summar")).toBeGreaterThanOrEqual(0);
  });

  it("shows (fork) for children without summary", () => {
    const child = makeSession({ summary: null });
    const row = formatChildRow(child);
    expect(row).toContain("(fork)");
  });
});
