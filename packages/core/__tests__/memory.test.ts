/**
 * Tests for cross-session memory: remember, recall, forget, clear, format.
 */

import { describe, it, expect } from "bun:test";
import { remember, recall, forget, listMemories, clearMemories, formatMemoriesForPrompt } from "../memory.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

describe("remember / recall round-trip", () => {
  it("stores and retrieves a memory", () => {
    const entry = remember("TypeScript uses .js extensions for ES module imports", {
      tags: ["typescript", "imports"],
      scope: "project/ark",
    });
    expect(entry.id).toMatch(/^mem-/);
    expect(entry.content).toBe("TypeScript uses .js extensions for ES module imports");
    expect(entry.tags).toEqual(["typescript", "imports"]);
    expect(entry.scope).toBe("project/ark");
    expect(entry.importance).toBe(0.5);
    expect(entry.accessCount).toBe(0);

    const results = recall("typescript imports extensions", { scope: "project/ark" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain("TypeScript");
  });

  it("returns empty array for unrelated query", () => {
    remember("SQLite uses WAL mode for concurrency");
    const results = recall("quantum physics entanglement", { minScore: 0.5 });
    expect(results.length).toBe(0);
  });
});

describe("keyword scoring", () => {
  it("ranks tag matches higher than content matches", () => {
    remember("The database layer handles persistence", { tags: ["database"] });
    remember("Database connections use WAL mode for performance", { tags: ["performance"] });

    const results = recall("database");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The one tagged "database" should rank higher
    expect(results[0].tags).toContain("database");
  });

  it("respects importance weighting", () => {
    remember("Low importance fact about testing", { importance: 0.1, tags: ["testing"] });
    remember("High importance fact about testing", { importance: 1.0, tags: ["testing"] });

    const results = recall("testing");
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Higher importance should rank first (same keyword match, same recency)
    expect(results[0].content).toContain("High importance");
  });
});

describe("scope filtering", () => {
  it("filters by scope and includes global", () => {
    remember("Global knowledge about git", { scope: "global", tags: ["git"] });
    remember("Project-specific git config", { scope: "project/myapp", tags: ["git"] });
    remember("Other project git workflow", { scope: "project/other", tags: ["git"] });

    const results = recall("git", { scope: "project/myapp" });
    const scopes = results.map(r => r.scope);
    expect(scopes).toContain("global");
    expect(scopes).toContain("project/myapp");
    expect(scopes).not.toContain("project/other");
  });
});

describe("forget", () => {
  it("removes a specific memory", () => {
    const entry = remember("Temporary note to forget");
    expect(forget(entry.id)).toBe(true);

    const all = listMemories();
    expect(all.find(e => e.id === entry.id)).toBeUndefined();
  });

  it("returns false for nonexistent id", () => {
    expect(forget("mem-nonexistent")).toBe(false);
  });
});

describe("clearMemories", () => {
  it("clears all memories when no scope given", () => {
    remember("one");
    remember("two");
    remember("three");
    const count = clearMemories();
    expect(count).toBeGreaterThanOrEqual(3);
    expect(listMemories().length).toBe(0);
  });

  it("clears only memories matching scope", () => {
    remember("keep this", { scope: "global" });
    remember("remove this", { scope: "temp" });
    remember("also remove", { scope: "temp" });

    const removed = clearMemories("temp");
    expect(removed).toBe(2);

    const remaining = listMemories();
    expect(remaining.every(m => m.scope !== "temp")).toBe(true);
  });
});

describe("listMemories", () => {
  it("lists all memories without scope filter", () => {
    remember("A", { scope: "global" });
    remember("B", { scope: "project/x" });
    const all = listMemories();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by scope and includes global", () => {
    remember("global item", { scope: "global" });
    remember("scoped item", { scope: "project/x" });
    remember("other item", { scope: "project/y" });

    const filtered = listMemories("project/x");
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
