import { describe, it, expect, beforeEach } from "bun:test";
import { recordLearning, getLearnings, getPolicies } from "../learnings.js";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("conductor learnings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ark-learnings-"));
  });

  it("records a new learning with recurrence 1", () => {
    const result = recordLearning(dir, "Test pattern", "Description of the pattern");
    expect(result.learning.title).toBe("Test pattern");
    expect(result.learning.recurrence).toBe(1);
    expect(result.promoted).toBe(false);
  });

  it("increments recurrence on repeated recording", () => {
    recordLearning(dir, "Repeated", "A repeated pattern");
    const result = recordLearning(dir, "Repeated", "Updated description");
    expect(result.learning.recurrence).toBe(2);
    expect(result.promoted).toBe(false);
  });

  it("promotes to policy at recurrence >= 3", () => {
    recordLearning(dir, "Frequent", "Happens a lot");
    recordLearning(dir, "Frequent", "Happens a lot");
    const result = recordLearning(dir, "Frequent", "Happens a lot");
    expect(result.promoted).toBe(true);

    // Should be in policy now
    const policies = getPolicies(dir);
    expect(policies.length).toBe(1);
    expect(policies[0].title).toBe("Frequent");

    // Should be removed from learnings
    const learnings = getLearnings(dir);
    expect(learnings.find(l => l.title === "Frequent")).toBeUndefined();
  });

  it("does not duplicate policy entries", () => {
    recordLearning(dir, "Dup", "Duplicate test");
    recordLearning(dir, "Dup", "Duplicate test");
    recordLearning(dir, "Dup", "Duplicate test");  // promotes
    // Recording again should not re-add to learnings (it was removed)
    recordLearning(dir, "Dup", "Duplicate test");  // recurrence 1 again
    const policies = getPolicies(dir);
    expect(policies.length).toBe(1);  // still just one policy
  });

  it("getLearnings returns empty for missing directory", () => {
    expect(getLearnings("/tmp/nonexistent-dir-xyz")).toEqual([]);
  });

  it("getPolicies returns empty for missing directory", () => {
    expect(getPolicies("/tmp/nonexistent-dir-xyz")).toEqual([]);
  });
});

describe("conductor learnings advanced", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ark-learnings-adv-"));
  });

  it("tracks multiple independent learnings", () => {
    recordLearning(dir, "Pattern A", "First pattern");
    recordLearning(dir, "Pattern B", "Second pattern");
    recordLearning(dir, "Pattern A", "First again");

    const learnings = getLearnings(dir);
    expect(learnings.length).toBe(2);

    const a = learnings.find(l => l.title === "Pattern A");
    const b = learnings.find(l => l.title === "Pattern B");
    expect(a!.recurrence).toBe(2);
    expect(b!.recurrence).toBe(1);
  });

  it("promotion of one learning does not affect others", () => {
    recordLearning(dir, "Promoted", "Will be promoted");
    recordLearning(dir, "Promoted", "Will be promoted");
    recordLearning(dir, "Promoted", "Will be promoted"); // promotes
    recordLearning(dir, "Stays", "Should stay in learnings");

    const learnings = getLearnings(dir);
    const policies = getPolicies(dir);
    expect(learnings.length).toBe(1);
    expect(learnings[0].title).toBe("Stays");
    expect(policies.length).toBe(1);
    expect(policies[0].title).toBe("Promoted");
  });

  it("records learning with empty description", () => {
    const result = recordLearning(dir, "No description", "");
    expect(result.learning.title).toBe("No description");
    expect(result.learning.description).toBe("");
  });

  it("re-recording a promoted learning starts fresh at recurrence 1", () => {
    // Promote it
    recordLearning(dir, "Cycled", "A cycling pattern");
    recordLearning(dir, "Cycled", "A cycling pattern");
    recordLearning(dir, "Cycled", "A cycling pattern");

    // Record again — should start fresh
    const result = recordLearning(dir, "Cycled", "New version");
    expect(result.learning.recurrence).toBe(1);
    expect(result.promoted).toBe(false);

    // Policy should still exist
    const policies = getPolicies(dir);
    expect(policies.find(p => p.title === "Cycled")).toBeDefined();
  });

  it("updates description on re-recording", () => {
    recordLearning(dir, "Evolving", "Original description");
    recordLearning(dir, "Evolving", "Updated description");
    const learnings = getLearnings(dir);
    const l = learnings.find(l => l.title === "Evolving");
    expect(l!.description).toBe("Updated description");
  });

  it("updates lastSeen timestamp on re-recording", () => {
    const r1 = recordLearning(dir, "Timed", "First");
    const t1 = r1.learning.lastSeen;
    // Record again
    const r2 = recordLearning(dir, "Timed", "Second");
    expect(r2.learning.lastSeen).toBeDefined();
    // Both should be valid ISO dates
    expect(new Date(t1).getTime()).toBeGreaterThan(0);
    expect(new Date(r2.learning.lastSeen).getTime()).toBeGreaterThan(0);
  });

  it("policy includes promotedOn timestamp", () => {
    recordLearning(dir, "WithDate", "Test");
    recordLearning(dir, "WithDate", "Test");
    recordLearning(dir, "WithDate", "Test");
    const policies = getPolicies(dir);
    expect(policies[0].promotedOn).toBeDefined();
    expect(new Date(policies[0].promotedOn).getTime()).toBeGreaterThan(0);
  });

  it("handles many learnings without corruption", () => {
    for (let i = 0; i < 10; i++) {
      recordLearning(dir, `Learning ${i}`, `Description for ${i}`);
    }
    const learnings = getLearnings(dir);
    expect(learnings.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(learnings.find(l => l.title === `Learning ${i}`)).toBeDefined();
    }
  });
});
