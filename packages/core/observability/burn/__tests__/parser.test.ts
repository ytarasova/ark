import { describe, it, expect } from "bun:test";
import { join } from "path";
import { parseClaudeTranscript } from "../parser.js";

const fixturePath = join(import.meta.dir, "fixtures", "claude-session.jsonl");

describe("parseClaudeTranscript", () => {
  it("parses fixture into >= 8 classified turns", () => {
    const { turns } = parseClaudeTranscript(fixturePath, "myproject");
    expect(turns.length).toBeGreaterThanOrEqual(8);
  });

  it("deduplicates by message id (all dedup keys unique)", () => {
    const { turns } = parseClaudeTranscript(fixturePath, "myproject");
    const allKeys = turns.flatMap(t =>
      t.assistantCalls.map(c => c.deduplicationKey),
    );
    const uniqueKeys = new Set(allKeys);
    expect(uniqueKeys.size).toBe(allKeys.length);
  });

  it("assigns categories (Set has 'coding')", () => {
    const { turns } = parseClaudeTranscript(fixturePath, "myproject");
    const categories = new Set(turns.map(t => t.category));
    expect(categories.has("coding")).toBe(true);
  });

  it("computes session summary (totalCostUSD > 0, apiCalls >= 8, categoryBreakdown keys >= 3)", () => {
    const { summary } = parseClaudeTranscript(fixturePath, "myproject");
    expect(summary.totalCostUSD).toBeGreaterThan(0);
    expect(summary.apiCalls).toBeGreaterThanOrEqual(8);
    expect(Object.keys(summary.categoryBreakdown).length).toBeGreaterThanOrEqual(3);
    expect(summary.project).toBe("myproject");
    expect(summary.totalInputTokens).toBeGreaterThan(0);
    expect(summary.totalOutputTokens).toBeGreaterThan(0);
  });

  it("detects one-shot turns (coding editTurns > 0)", () => {
    const { summary } = parseClaudeTranscript(fixturePath, "myproject");
    // At least one category should have edit turns
    const allEditTurns = Object.values(summary.categoryBreakdown)
      .reduce((sum, cat) => sum + cat.editTurns, 0);
    expect(allEditTurns).toBeGreaterThan(0);
  });
});
