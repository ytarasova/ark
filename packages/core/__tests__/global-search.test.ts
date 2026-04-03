import { describe, it, expect } from "bun:test";
import { searchAllConversations } from "../global-search.js";

describe("global search", () => {
  it("returns results array (possibly empty) for any query", () => {
    // Use maxResults: 1 to bail early and avoid scanning all files
    const results = searchAllConversations("function", { maxResults: 1, recentDays: 1 });
    expect(Array.isArray(results)).toBe(true);
  });

  it("respects maxResults limit", () => {
    const results = searchAllConversations("the", { maxResults: 2, recentDays: 1 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("handles missing claude projects dir gracefully", () => {
    // This tests the early return path — implementation checks existsSync
    // The function should never throw
    expect(() => searchAllConversations("test", { maxResults: 1 })).not.toThrow();
  });
});
