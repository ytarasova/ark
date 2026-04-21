/**
 * Tests for LedgerRepository: load, addEntry, updateEntry, stall detection,
 * prompt formatting, and tenant isolation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { withTestContext, getApp } from "./test-helpers.js";

withTestContext();

const CID = "test-conductor-1";

// Each describe block uses a fresh conductor id so assertions on entry counts
// are independent. `beforeEach` wipes the specific conductor's rows.
async function fresh(conductorId: string): Promise<string> {
  await getApp().ledger.delete(conductorId);
  return conductorId;
}

describe("LedgerRepository.load", () => {
  const cid = "load-cid";
  beforeEach(async () => {
    await fresh(cid);
  });

  it("returns an empty ledger for a new conductor", async () => {
    const ledger = await getApp().ledger.load(cid);
    expect(ledger.conductorId).toBe(cid);
    expect(ledger.entries).toEqual([]);
    expect(ledger.stallCount).toBe(0);
  });

  it("reflects entries written via addEntry", async () => {
    await getApp().ledger.addEntry(cid, "fact", "repo uses TypeScript");
    const reloaded = await getApp().ledger.load(cid);
    expect(reloaded.entries.length).toBe(1);
    expect(reloaded.entries[0].content).toBe("repo uses TypeScript");
    expect(reloaded.conductorId).toBe(cid);
  });
});

describe("LedgerRepository.addEntry", () => {
  const cid = "add-cid";
  beforeEach(async () => {
    await fresh(cid);
  });

  it("creates an entry with a nanoid-shaped id + returns it", async () => {
    const entry = await getApp().ledger.addEntry(cid, "fact", "project has 10 files", "s-123");
    expect(entry.id).toMatch(/^le-[A-Za-z0-9_-]{10}$/);
    expect(entry.type).toBe("fact");
    expect(entry.content).toBe("project has 10 files");
    expect(entry.sessionId).toBe("s-123");
    expect(entry.status).toBeUndefined();
    const loaded = await getApp().ledger.load(cid);
    expect(loaded.entries.map((e) => e.id)).toContain(entry.id);
  });

  it("sets status=pending for plan_step entries", async () => {
    const entry = await getApp().ledger.addEntry(cid, "plan_step", "implement auth module");
    expect(entry.status).toBe("pending");
  });

  it("emits unique ids across a burst of writes", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < CID.length + 50; i++) {
      const e = await getApp().ledger.addEntry(cid, "fact", `burst ${i}`);
      expect(e.id).toMatch(/^le-[A-Za-z0-9_-]{10}$/);
      expect(ids.has(e.id)).toBe(false);
      ids.add(e.id);
    }
  });
});

describe("LedgerRepository.updateEntry", () => {
  const cid = "upd-cid";
  beforeEach(async () => {
    await fresh(cid);
  });

  it("updates an existing entry", async () => {
    const entry = await getApp().ledger.addEntry(cid, "plan_step", "write tests");
    await getApp().ledger.updateEntry(cid, entry.id, { status: "completed", content: "write tests - done" });
    const ledger = await getApp().ledger.load(cid);
    const updated = ledger.entries.find((e) => e.id === entry.id)!;
    expect(updated.status).toBe("completed");
    expect(updated.content).toBe("write tests - done");
    expect(updated.updatedAt).toBeTruthy();
  });

  it("is a silent no-op for a nonexistent entry", async () => {
    await getApp().ledger.addEntry(cid, "fact", "exists");
    await getApp().ledger.updateEntry(cid, "le-nonexistent", { content: "nope" });
    const entries = (await getApp().ledger.load(cid)).entries;
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe("exists");
  });
});

describe("LedgerRepository.detectStall", () => {
  const cid = "stall-cid";
  beforeEach(async () => {
    await fresh(cid);
  });

  it("returns false when no progress entries exist", async () => {
    await getApp().ledger.addEntry(cid, "fact", "just a fact");
    expect(await getApp().ledger.detectStall(cid)).toBe(false);
  });

  it("returns true when the most-recent progress entry is older than the threshold", async () => {
    // Seed an old progress entry directly via the DB so we can backdate `created_at`.
    const oldTs = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await getApp()
      .db.prepare(
        `INSERT INTO ledger_entries
           (id, conductor_id, tenant_id, type, content, status, session_id, created_at, updated_at)
         VALUES (?, ?, ?, 'progress', 'old progress', NULL, NULL, ?, ?)`,
      )
      .run("le-old-progress", cid, "default", oldTs, oldTs);

    expect(await getApp().ledger.detectStall(cid, 10)).toBe(true);
    // First detection appends a single stall entry.
    const reloaded = await getApp().ledger.load(cid);
    expect(reloaded.entries.filter((e) => e.type === "stall").length).toBe(1);
    expect(reloaded.stallCount).toBeGreaterThan(0);
  });
});

describe("LedgerRepository.formatPrompt", () => {
  const cid = "fmt-cid";
  beforeEach(async () => {
    await fresh(cid);
  });

  it("returns empty string for an empty ledger", async () => {
    expect(await getApp().ledger.formatPrompt(cid)).toBe("");
  });

  it("formats facts, plan steps, and recent activity", async () => {
    await getApp().ledger.addEntry(cid, "fact", "monorepo with 3 packages");
    await getApp().ledger.addEntry(cid, "plan_step", "step 1: analyze");
    await getApp().ledger.addEntry(cid, "progress", "started analysis");
    const prompt = await getApp().ledger.formatPrompt(cid);
    expect(prompt).toContain("## Task Ledger");
    expect(prompt).toContain("### Facts");
    expect(prompt).toContain("monorepo with 3 packages");
    expect(prompt).toContain("### Plan");
    expect(prompt).toContain("[pending] step 1: analyze");
    expect(prompt).toContain("### Recent Activity");
  });
});

describe("LedgerRepository tenant isolation", () => {
  it("writes from tenant-a are invisible to tenant-b", async () => {
    const cid = "tenant-shared";
    const repo = getApp().ledger;

    repo.setTenant("tenant-a");
    await repo.delete(cid);
    await repo.addEntry(cid, "fact", "a-only fact");

    repo.setTenant("tenant-b");
    await repo.delete(cid);
    expect((await repo.load(cid)).entries).toEqual([]);

    repo.setTenant("tenant-a");
    expect((await repo.load(cid)).entries[0].content).toBe("a-only fact");

    repo.setTenant("default");
  });
});
