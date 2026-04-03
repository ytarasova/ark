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
