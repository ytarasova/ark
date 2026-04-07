/**
 * Tests for recipe evaluation: setup, missing recipe, summary stats, error handling.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { evaluateRecipeSetup } from "../recipe-eval.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { ARK_DIR } from "../paths.js";
import { stringify as stringifyYaml } from "yaml";

withTestContext();

function writeTestRecipe(name: string) {
  const dir = join(ARK_DIR(), "recipes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), stringifyYaml({
    name,
    description: "Test recipe",
    flow: "quick",
    variables: [],
    defaults: { summary: "test task" },
  }));
}

describe("evaluateRecipeSetup", () => {
  it("returns empty result for missing recipe", () => {
    const result = evaluateRecipeSetup("nonexistent-recipe", 3);
    expect(result.recipeName).toBe("nonexistent-recipe");
    expect(result.iterations).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.summary.successRate).toBe(0);
  });

  it("creates sessions for each iteration", () => {
    writeTestRecipe("eval-test");
    const result = evaluateRecipeSetup("eval-test", 3);

    expect(result.recipeName).toBe("eval-test");
    expect(result.iterations).toBe(3);
    expect(result.results.length).toBe(3);

    for (let i = 0; i < 3; i++) {
      expect(result.results[i].sessionId).toMatch(/^s-/);
      expect(result.results[i].status).toBe("ready");
      expect(result.results[i].durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("calculates summary statistics", () => {
    writeTestRecipe("eval-summary");
    const result = evaluateRecipeSetup("eval-summary", 2);

    expect(result.summary.successRate).toBe(1);
    expect(result.summary.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(result.summary.avgCost).toBe(0); // no usage data on fresh sessions
    expect(result.summary.totalCost).toBe(0);
  });

  it("handles zero iterations", () => {
    writeTestRecipe("eval-zero");
    const result = evaluateRecipeSetup("eval-zero", 0);

    expect(result.iterations).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.summary.successRate).toBe(0);
    expect(result.summary.avgDurationMs).toBe(0);
  });
});
