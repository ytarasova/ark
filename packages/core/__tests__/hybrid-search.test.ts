import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext, type TestContext } from "../context.js";
import { remember } from "../memory.js";
import { hybridSearch, mergeAndDeduplicate, type HybridSearchResult } from "../hybrid-search.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

describe("mergeAndDeduplicate", () => {
  it("removes duplicate content across sources", () => {
    const results: HybridSearchResult[] = [
      { source: "memory", content: "same content", score: 0.8, metadata: {} },
      { source: "knowledge", content: "same content", score: 0.6, metadata: {} },
      { source: "transcript", content: "different content", score: 0.5, metadata: {} },
    ];
    const deduped = mergeAndDeduplicate(results);
    expect(deduped.length).toBe(2);
    expect(deduped[0].source).toBe("memory");  // higher score kept
  });

  it("sorts by score descending", () => {
    const results: HybridSearchResult[] = [
      { source: "memory", content: "low", score: 0.2, metadata: {} },
      { source: "knowledge", content: "high", score: 0.9, metadata: {} },
      { source: "transcript", content: "mid", score: 0.5, metadata: {} },
    ];
    const deduped = mergeAndDeduplicate(results);
    expect(deduped[0].content).toBe("high");
    expect(deduped[2].content).toBe("low");
  });
});

describe("hybridSearch", () => {
  it("returns results from memory source", async () => {
    remember("TypeScript compiler options for strict mode", {
      tags: ["typescript", "config"], scope: "global", importance: 0.8,
    });
    const results = await hybridSearch("typescript strict", {
      sources: ["memory"], rerank: false,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("memory");
    expect(results[0].content).toContain("TypeScript");
  });

  it("respects limit option", async () => {
    for (let i = 0; i < 5; i++) {
      remember(`Memory entry number ${i} about testing`, {
        tags: ["test"], scope: "global", importance: 0.5,
      });
    }
    const results = await hybridSearch("testing", {
      sources: ["memory"], rerank: false, limit: 2,
    });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it("returns empty array for no matches", async () => {
    const results = await hybridSearch("xyznonexistent987", {
      sources: ["memory"], rerank: false,
    });
    expect(results).toEqual([]);
  });
});
