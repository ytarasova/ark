import { describe, it, expect } from "bun:test";
import { scoreOutput, summarizeResults, listEvalSuites } from "../evals.js";
import type { EvalResult } from "../evals.js";

describe("evals", () => {
  it("scoreOutput matches expected keywords", () => {
    const { score, matched, missed } = scoreOutput(
      "The function returns a sorted array of numbers",
      ["sorted", "array", "numbers", "error handling"]
    );
    expect(matched).toContain("sorted");
    expect(matched).toContain("array");
    expect(matched).toContain("numbers");
    expect(missed).toContain("error handling");
    expect(score).toBeCloseTo(0.75, 2);
  });

  it("scoreOutput is case insensitive", () => {
    const { score } = scoreOutput("Hello World", ["hello", "WORLD"]);
    expect(score).toBe(1);
  });

  it("scoreOutput handles empty expected", () => {
    const { score } = scoreOutput("anything", []);
    expect(score).toBe(0);
  });

  it("summarizeResults computes averages", () => {
    const results: EvalResult[] = [
      { scenario: "a", passed: true, score: 1.0, duration_ms: 100, matchedOutcomes: ["x"], missedOutcomes: [], timestamp: "" },
      { scenario: "b", passed: false, score: 0.5, duration_ms: 200, matchedOutcomes: ["y"], missedOutcomes: ["z"], timestamp: "" },
    ];
    const summary = summarizeResults(results);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.avgScore).toBeCloseTo(0.75, 2);
    expect(summary.avgDuration).toBe(150);
  });

  it("summarizeResults handles empty", () => {
    const summary = summarizeResults([]);
    expect(summary.total).toBe(0);
    expect(summary.avgScore).toBe(0);
  });

  it("listEvalSuites returns array", () => {
    const suites = listEvalSuites();
    expect(Array.isArray(suites)).toBe(true);
  });
});
