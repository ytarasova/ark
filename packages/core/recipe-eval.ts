/**
 * Recipe evaluation — run a recipe N times and measure performance.
 */

import { loadRecipe, instantiateRecipe } from "./recipe.js";
import { startSession } from "./session.js";
import type { Session } from "./store.js";
import { getSessionCost } from "./costs.js";

export interface RecipeEvalResult {
  recipeName: string;
  iterations: number;
  results: Array<{
    sessionId: string;
    status: string;
    durationMs: number;
    cost: number;
    error?: string;
  }>;
  summary: {
    successRate: number;
    avgDurationMs: number;
    avgCost: number;
    totalCost: number;
  };
}

/** Run a recipe evaluation (creates sessions but does NOT dispatch — that requires real agents). */
export function evaluateRecipeSetup(recipeName: string, iterations: number, variables?: Record<string, string>): RecipeEvalResult {
  const recipe = loadRecipe(recipeName);
  if (!recipe) {
    return {
      recipeName,
      iterations: 0,
      results: [],
      summary: { successRate: 0, avgDurationMs: 0, avgCost: 0, totalCost: 0 },
    };
  }

  const results: RecipeEvalResult["results"] = [];

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    try {
      const instance = instantiateRecipe(recipe, variables ?? {});
      const session = startSession({
        summary: `[eval] ${recipeName} #${i + 1}`,
        repo: (instance as any).repo ?? ".",
        flow: (instance as any).flow ?? recipe.flow ?? "quick",
        config: { eval: true, evalIteration: i + 1 },
      });

      const cost = getSessionCost(session);
      results.push({
        sessionId: session.id,
        status: session.status,
        durationMs: Date.now() - start,
        cost: cost.cost,
      });
    } catch (e: any) {
      results.push({
        sessionId: "",
        status: "error",
        durationMs: Date.now() - start,
        cost: 0,
        error: e.message,
      });
    }
  }

  const successful = results.filter(r => r.status !== "error");
  const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
  const totalCost = results.reduce((s, r) => s + r.cost, 0);

  return {
    recipeName,
    iterations,
    results,
    summary: {
      successRate: results.length > 0 ? successful.length / results.length : 0,
      avgDurationMs: results.length > 0 ? totalDuration / results.length : 0,
      avgCost: results.length > 0 ? totalCost / results.length : 0,
      totalCost,
    },
  };
}
