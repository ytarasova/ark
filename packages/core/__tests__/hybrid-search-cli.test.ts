// packages/core/__tests__/hybrid-search-cli.test.ts
import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { hybridSearch } from "../hybrid-search.js";
import { remember } from "../memory.js";

withTestContext();

describe("hybridSearch sources filter", () => {
  it("queries only specified sources", async () => {
    remember("Important deployment note", {
      tags: ["deploy"], scope: "global", importance: 0.9,
    });

    const memResults = await hybridSearch("deployment", {
      sources: ["memory"], rerank: false,
    });
    expect(memResults.length).toBeGreaterThan(0);

    const txResults = await hybridSearch("deployment", {
      sources: ["transcript"], rerank: false,
    });
    const hasMemory = txResults.some(r => r.source === "memory");
    expect(hasMemory).toBe(false);
  });

  it("rerank: false returns results without API call", async () => {
    remember("Search test entry", { tags: ["test"], scope: "global", importance: 0.7 });
    const results = await hybridSearch("search test", { rerank: false });
    expect(results.length).toBeGreaterThan(0);
  });
});
