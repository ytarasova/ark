/**
 * Tests for task/progress ledger: load/save, entries, stall detection, prompt formatting.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { loadLedger, saveLedger, addEntry, updateEntry, detectStall, formatLedgerForPrompt } from "../ledger.js";
import { getApp } from "./test-helpers.js";

withTestContext();

const CID = "test-conductor-1";

describe("loadLedger / saveLedger", () => {
  it("round-trips a ledger through save and load", () => {
    const ledger = loadLedger(getApp(), CID);
    expect(ledger.conductorId).toBe(CID);
    expect(ledger.entries).toEqual([]);
    expect(ledger.stallCount).toBe(0);

    ledger.entries.push({
      id: "le-1",
      type: "fact",
      content: "repo uses TypeScript",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    saveLedger(getApp(), ledger);

    const reloaded = loadLedger(getApp(), CID);
    expect(reloaded.entries.length).toBe(1);
    expect(reloaded.entries[0].content).toBe("repo uses TypeScript");
    expect(reloaded.conductorId).toBe(CID);
  });
});

describe("addEntry", () => {
  it("creates an entry and persists it", () => {
    const entry = addEntry(getApp(), CID, "fact", "project has 10 files", "s-123");
    // Ledger IDs are `le-<10 url-safe chars>` via nanoid -- non-crypto
    // Math.random fallback is no longer acceptable here.
    expect(entry.id).toMatch(/^le-[A-Za-z0-9_-]{10}$/);
    expect(entry.type).toBe("fact");
    expect(entry.content).toBe("project has 10 files");
    expect(entry.sessionId).toBe("s-123");
    expect(entry.status).toBeUndefined();

    const ledger = loadLedger(getApp(), CID);
    expect(ledger.entries.length).toBe(1);
    expect(ledger.entries[0].id).toBe(entry.id);
  });

  it("sets status to pending for plan_step entries", () => {
    const entry = addEntry(getApp(), CID, "plan_step", "implement auth module");
    expect(entry.status).toBe("pending");
  });

  it("emits unique ids across a burst of entries", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const e = addEntry(getApp(), CID, "fact", `burst ${i}`);
      expect(e.id).toMatch(/^le-[A-Za-z0-9_-]{10}$/);
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
    }
    expect(ids.size).toBe(100);
  });
});

describe("updateEntry", () => {
  it("updates an existing entry", () => {
    const entry = addEntry(getApp(), CID, "plan_step", "write tests");
    updateEntry(getApp(), CID, entry.id, { status: "completed", content: "write tests - done" });

    const ledger = loadLedger(getApp(), CID);
    const updated = ledger.entries.find((e) => e.id === entry.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.content).toBe("write tests - done");
    // updatedAt should be a valid ISO timestamp (may be same ms as creation)
    expect(updated.updatedAt).toBeTruthy();
  });

  it("does nothing for nonexistent entry", () => {
    addEntry(getApp(), CID, "fact", "exists");
    updateEntry(getApp(), CID, "le-nonexistent", { content: "nope" });
    const ledger = loadLedger(getApp(), CID);
    expect(ledger.entries.length).toBe(1);
    expect(ledger.entries[0].content).toBe("exists");
  });
});

describe("detectStall", () => {
  it("returns false when no progress entries exist", () => {
    addEntry(getApp(), CID, "fact", "just a fact");
    expect(detectStall(getApp(), CID)).toBe(false);
  });

  it("detects stall when progress is old", () => {
    const ledger = loadLedger(getApp(), CID);
    ledger.entries.push({
      id: "le-old",
      type: "progress",
      content: "old progress",
      createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(), // 20 min ago
      updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    });
    saveLedger(getApp(), ledger);

    expect(detectStall(getApp(), CID, 10)).toBe(true);

    // Should have added a stall entry
    const reloaded = loadLedger(getApp(), CID);
    const stallEntries = reloaded.entries.filter((e) => e.type === "stall");
    expect(stallEntries.length).toBe(1);
    expect(reloaded.stallCount).toBeGreaterThan(0);
  });
});

describe("formatLedgerForPrompt", () => {
  it("returns empty string for empty ledger", () => {
    expect(formatLedgerForPrompt(getApp(), CID)).toBe("");
  });

  it("formats facts, plan steps, and recent activity", () => {
    addEntry(getApp(), CID, "fact", "monorepo with 3 packages");
    addEntry(getApp(), CID, "plan_step", "step 1: analyze");
    addEntry(getApp(), CID, "progress", "started analysis");

    const prompt = formatLedgerForPrompt(getApp(), CID);
    expect(prompt).toContain("## Task Ledger");
    expect(prompt).toContain("### Facts");
    expect(prompt).toContain("monorepo with 3 packages");
    expect(prompt).toContain("### Plan");
    expect(prompt).toContain("[pending] step 1: analyze");
    expect(prompt).toContain("### Recent Activity");
  });
});
