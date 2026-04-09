/**
 * Tests for cross-session memory: remember, recall, forget, clear, format.
 */

import { describe, it, expect } from "bun:test";
import { remember, recall, forget, listMemories, clearMemories, formatMemoriesForPrompt } from "../memory.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();
const app = () => getApp();

describe("remember / recall round-trip", () => {
  it("stores and retrieves a memory", () => {
    const entry = remember(app(),"TypeScript uses .js extensions for ES module imports", {
      tags: ["typescript", "imports"],
      scope: "project/ark",
    });
    expect(entry.id).toMatch(/^mem-/);
    expect(entry.content).toBe("TypeScript uses .js extensions for ES module imports");
    expect(entry.tags).toEqual(["typescript", "imports"]);
    expect(entry.scope).toBe("project/ark");
    expect(entry.importance).toBe(0.5);
    expect(entry.accessCount).toBe(0);

    const results = recall(app(),"typescript imports extensions", { scope: "project/ark" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("TypeScript");
  });

  it("returns empty array for unrelated query", () => {
    remember(app(),"SQLite uses WAL mode for concurrency");
    const results = recall(app(),"quantum physics entanglement", { minScore: 0.5 });
    expect(results.length).toBe(0);
  });
});

describe("keyword scoring", () => {
  it("ranks tag matches higher than content matches", () => {
    remember(app(),"The database layer handles persistence", { tags: ["database"] });
    remember(app(),"Database connections use WAL mode for performance", { tags: ["performance"] });

    const results = recall(app(),"database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The one tagged "database" should rank higher
    expect(results[0].tags).toContain("database");
  });

  it("respects importance weighting", () => {
    remember(app(),"Low importance fact about testing", { importance: 0.1, tags: ["testing"] });
    remember(app(),"High importance fact about testing", { importance: 1.0, tags: ["testing"] });

    const results = recall(app(),"testing");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Higher importance should rank first (same keyword match, same recency)
    expect(results[0].content).toContain("High importance");
  });
});

describe("scope filtering", () => {
  it("filters by scope and includes global", () => {
    remember(app(),"Global knowledge about git", { scope: "global", tags: ["git"] });
    remember(app(),"Project-specific git config", { scope: "project/myapp", tags: ["git"] });
    remember(app(),"Other project git workflow", { scope: "project/other", tags: ["git"] });

    const results = recall(app(),"git", { scope: "project/myapp" });
    const scopes = results.map(r => r.scope);
    expect(scopes).toContain("global");
    expect(scopes).toContain("project/myapp");
    expect(scopes).not.toContain("project/other");
  });
});

describe("forget", () => {
  it("removes a specific memory", () => {
    const entry = remember(app(),"Temporary note to forget");
    expect(forget(app(),entry.id)).toBe(true);

    const all = listMemories(app(),);
    expect(all.find(e => e.id === entry.id)).toBeUndefined();
  });

  it("returns false for nonexistent id", () => {
    expect(forget(app(),"mem-nonexistent")).toBe(false);
  });
});

describe("clearMemories", () => {
  it("clears all memories when no scope given", () => {
    remember(app(),"one");
    remember(app(),"two");
    remember(app(),"three");
    const count = clearMemories(app(),);
    expect(count).toBeGreaterThanOrEqual(3);
    expect(listMemories(app(),).length).toBe(0);
  });

  it("clears only memories matching scope", () => {
    remember(app(),"keep this", { scope: "global" });
    remember(app(),"remove this", { scope: "temp" });
    remember(app(),"also remove", { scope: "temp" });

    const removed = clearMemories(app(),"temp");
    expect(removed).toBe(2);

    const remaining = listMemories(app(),);
    expect(remaining.every(m => m.scope !== "temp")).toBe(true);
  });
});

describe("listMemories", () => {
  it("lists all memories without scope filter", () => {
    remember(app(),"A", { scope: "global" });
    remember(app(),"B", { scope: "project/x" });
    const all = listMemories(app(),);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by scope and includes global", () => {
    remember(app(),"global item", { scope: "global" });
    remember(app(),"scoped item", { scope: "project/x" });
    remember(app(),"other item", { scope: "project/y" });

    const filtered = listMemories(app(),"project/x");
    expect(filtered.some(m => m.scope === "project/x")).toBe(true);
    expect(filtered.some(m => m.scope === "global")).toBe(true);
    expect(filtered.every(m => m.scope !== "project/y")).toBe(true);
  });
});

describe("formatMemoriesForPrompt", () => {
  it("returns empty string for empty list", () => {
    expect(formatMemoriesForPrompt([])).toBe("");
  });

  it("formats memories with tags", () => {
    const memories = [
      { id: "mem-1", content: "Use bun:test not vitest", tags: ["testing"], scope: "global", importance: 0.5, createdAt: "", accessedAt: "", accessCount: 0 },
      { id: "mem-2", content: "Strict false in tsconfig", tags: [], scope: "global", importance: 0.5, createdAt: "", accessedAt: "", accessCount: 0 },
    ];
    const prompt = formatMemoriesForPrompt(memories);
    expect(prompt).toContain("## Relevant Memories");
    expect(prompt).toContain("- Use bun:test not vitest [testing]");
    expect(prompt).toContain("- Strict false in tsconfig");
    // No tag brackets for tagless entry
    expect(prompt).not.toContain("Strict false in tsconfig [");
  });
});
