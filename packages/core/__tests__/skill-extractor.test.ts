/**
 * Tests for skill-extractor.ts — heuristic skill extraction from conversations.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { extractSkillCandidates } from "../skill-extractor.js";

const { getCtx } = withTestContext();

describe("skill extraction", () => {
  it("identifies numbered-step procedures as skill candidates", () => {
    const conversation = [
      { role: "user", content: "Review the PR changes and check for security issues" },
      { role: "assistant", content: "I'll review the changes...\n1. Check for SQL injection\n2. Check for XSS vulnerabilities\n3. Verify authentication flows\n4. Review authorization checks" },
      { role: "user", content: "Now write tests for the security fixes" },
      { role: "assistant", content: "Writing security tests...\n1. Test SQL injection prevention\n2. Test XSS sanitization\n3. Test auth token validation" },
    ];

    const candidates = extractSkillCandidates(conversation);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    // Candidates should have name, description, prompt, confidence
    for (const c of candidates) {
      expect(c.name).toBeDefined();
      expect(c.description).toBeDefined();
      expect(c.prompt).toBeDefined();
      expect(typeof c.confidence).toBe("number");
      expect(c.confidence).toBeGreaterThan(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty array for trivial conversations (< 4 turns)", () => {
    const conversation = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const candidates = extractSkillCandidates(conversation);
    expect(candidates).toEqual([]);
  });

  it("confidence scales with step count", () => {
    const threeSteps = [
      { role: "user", content: "Do something" },
      { role: "assistant", content: "1. Step one\n2. Step two\n3. Step three" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Done." },
    ];

    const sixSteps = [
      { role: "user", content: "Do something bigger" },
      { role: "assistant", content: "1. Step one\n2. Step two\n3. Step three\n4. Step four\n5. Step five\n6. Step six" },
      { role: "user", content: "Continue" },
      { role: "assistant", content: "Done." },
    ];

    const small = extractSkillCandidates(threeSteps);
    const large = extractSkillCandidates(sixSteps);

    expect(small.length).toBeGreaterThanOrEqual(1);
    expect(large.length).toBeGreaterThanOrEqual(1);
    // 3 steps = 3/5 = 0.6, 6 steps = min(6/5, 1) = 1.0
    expect(large[0].confidence).toBeGreaterThan(small[0].confidence);
  });

  it("returns empty for conversations with no numbered procedures", () => {
    const conversation = [
      { role: "user", content: "Tell me about TypeScript" },
      { role: "assistant", content: "TypeScript is a typed superset of JavaScript." },
      { role: "user", content: "What about interfaces?" },
      { role: "assistant", content: "Interfaces define the shape of objects." },
    ];

    const candidates = extractSkillCandidates(conversation);
    expect(candidates).toEqual([]);
  });
});
