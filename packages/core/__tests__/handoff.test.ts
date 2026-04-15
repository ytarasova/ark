/**
 * Tests for agent-initiated handoff detection.
 */

import { describe, it, expect } from "bun:test";
import { detectHandoff, hasHandoff } from "../handoff.js";

describe("detectHandoff", () => {
  it("detects HANDOFF: pattern with em-dash", () => {
    const output = "Analysis complete.\nHANDOFF: reviewer \u2014 Code changes need review before merge\nDone.";
    const signal = detectHandoff(output);
    expect(signal).not.toBeNull();
    expect(signal!.targetAgent).toBe("reviewer");
    expect(signal!.reason).toBe("Code changes need review before merge");
  });

  it("detects HANDOFF: pattern with hyphen", () => {
    const output = "HANDOFF: implementer - Ready to implement the planned changes";
    const signal = detectHandoff(output);
    expect(signal).not.toBeNull();
    expect(signal!.targetAgent).toBe("implementer");
    expect(signal!.reason).toBe("Ready to implement the planned changes");
  });

  it("detects HANDOFF: case-insensitively", () => {
    const output = "handoff: documenter - needs documentation update";
    const signal = detectHandoff(output);
    expect(signal).not.toBeNull();
    expect(signal!.targetAgent).toBe("documenter");
  });

  it("detects JSON block with handoff field", () => {
    const output =
      'Here is my recommendation:\n```json\n{"handoff": "reviewer", "reason": "PR ready for review"}\n```\nEnd of output.';
    const signal = detectHandoff(output);
    expect(signal).not.toBeNull();
    expect(signal!.targetAgent).toBe("reviewer");
    expect(signal!.reason).toBe("PR ready for review");
  });

  it("detects JSON block with context", () => {
    const output =
      '```json\n{"handoff": "implementer", "reason": "Plan approved", "context": {"files": ["src/main.ts"]}}\n```';
    const signal = detectHandoff(output);
    expect(signal).not.toBeNull();
    expect(signal!.targetAgent).toBe("implementer");
    expect(signal!.reason).toBe("Plan approved");
    expect(signal!.context).toEqual({ files: ["src/main.ts"] });
  });

  it("detects 'hand off to <agent>' pattern", () => {
    const output = "I've completed the planning phase. Let me hand off to implementer for the actual coding.";
    const signal = detectHandoff(output);
    expect(signal).not.toBeNull();
    expect(signal!.targetAgent).toBe("implementer");
    expect(signal!.reason).toBe("Agent-initiated handoff");
  });

  it("detects 'Hand off to' case-insensitively", () => {
    const output = "Hand Off To reviewer now.";
    const signal = detectHandoff(output);
    expect(signal).not.toBeNull();
    expect(signal!.targetAgent).toBe("reviewer");
  });

  it("returns null for clean output with no handoff", () => {
    const output = "I've completed the implementation. All tests pass. The code is ready.";
    expect(detectHandoff(output)).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(detectHandoff("")).toBeNull();
  });
});

describe("hasHandoff", () => {
  it("returns true when handoff is present", () => {
    expect(hasHandoff("HANDOFF: reviewer \u2014 needs review")).toBe(true);
  });

  it("returns false for clean output", () => {
    expect(hasHandoff("All done. No further action needed.")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasHandoff("")).toBe(false);
  });
});
