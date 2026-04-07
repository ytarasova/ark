import { describe, it, expect } from "bun:test";
import { evaluateTermination, parseTermination, maxTurns, maxTokens, timeout, textMention, and, or } from "../termination.js";
import type { TerminationContext } from "../termination.js";
import type { Session } from "../../types/index.js";

const ctx: TerminationContext = {
  session: { status: "running" } as Session,
  turnCount: 10,
  tokenCount: 50000,
  elapsedMs: 30000,
  lastOutput: "Task completed successfully DONE",
};

describe("termination conditions", () => {
  it("maxTurns triggers at threshold", () => {
    expect(evaluateTermination(maxTurns(10), ctx)).toBe(true);
    expect(evaluateTermination(maxTurns(20), ctx)).toBe(false);
  });

  it("maxTokens triggers at threshold", () => {
    expect(evaluateTermination(maxTokens(50000), ctx)).toBe(true);
    expect(evaluateTermination(maxTokens(100000), ctx)).toBe(false);
  });

  it("timeout triggers at threshold", () => {
    expect(evaluateTermination(timeout(30), ctx)).toBe(true);
    expect(evaluateTermination(timeout(60), ctx)).toBe(false);
  });

  it("textMention detects keyword", () => {
    expect(evaluateTermination(textMention("DONE"), ctx)).toBe(true);
    expect(evaluateTermination(textMention("FAILED"), ctx)).toBe(false);
  });

  it("AND requires all conditions", () => {
    expect(evaluateTermination(and(maxTurns(10), textMention("DONE")), ctx)).toBe(true);
    expect(evaluateTermination(and(maxTurns(10), textMention("FAILED")), ctx)).toBe(false);
  });

  it("OR requires any condition", () => {
    expect(evaluateTermination(or(maxTurns(100), textMention("DONE")), ctx)).toBe(true);
    expect(evaluateTermination(or(maxTurns(100), textMention("FAILED")), ctx)).toBe(false);
  });

  it("parseTermination handles YAML objects", () => {
    const cond = parseTermination({ maxTurns: 50 });
    expect(cond).not.toBeNull();
    expect(cond!.type).toBe("maxTurns");
  });

  it("parseTermination handles nested AND/OR", () => {
    const cond = parseTermination({ or: [{ maxTurns: 100 }, { textMention: "STOP" }] });
    expect(cond!.type).toBe("or");
  });
});
