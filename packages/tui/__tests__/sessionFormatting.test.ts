/**
 * Tests for sessionFormatting — pure helpers for session detail pane.
 */

import { describe, it, expect } from "bun:test";
import {
  formatTokenDisplay,
  buildFileLinks,
  buildCommitLinks,
  stripAnsiAndFilter,
} from "../helpers/sessionFormatting.js";

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
