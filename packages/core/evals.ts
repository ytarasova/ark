/**
 * Evals framework — benchmark agent performance on test scenarios.
 * Each eval defines a task, expected outcomes, and scoring criteria.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import type { AppContext } from "./app.js";

export interface EvalScenario {
  name: string;
  description: string;
  task: string;                    // prompt to send to the agent
  expectedOutcomes: string[];      // keywords/patterns expected in output
  maxTurns?: number;
  timeoutMs?: number;
  tags?: string[];
}

export interface EvalResult {
  scenario: string;
  passed: boolean;
  score: number;          // 0-1
  duration_ms: number;
  matchedOutcomes: string[];
  missedOutcomes: string[];
  error?: string;
  timestamp: string;
}

export interface EvalSuite {
  name: string;
  scenarios: EvalScenario[];
}

/** Load eval scenarios from ~/.ark/evals/ directory. */
export function loadEvalSuite(app: AppContext, name: string): EvalSuite | null {
  const dirs = [
    join(app.config.arkDir, "evals"),
    join(process.cwd(), ".ark", "evals"),
    join(process.cwd(), "evals"),
  ];

  for (const dir of dirs) {
    const path = join(dir, `${name}.json`);
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, "utf-8"));
        return data as EvalSuite;
      } catch { continue; }
    }
  }
  return null;
}

/** Score an agent's output against expected outcomes. */
export function scoreOutput(output: string, expected: string[]): { score: number; matched: string[]; missed: string[] } {
  const lower = output.toLowerCase();
  const matched: string[] = [];
  const missed: string[] = [];

  for (const exp of expected) {
    if (lower.includes(exp.toLowerCase())) {
      matched.push(exp);
    } else {
      missed.push(exp);
    }
  }

  const score = expected.length > 0 ? matched.length / expected.length : 0;
  return { score, matched, missed };
}

/** Save eval results to ~/.ark/evals/results/ */
export function saveEvalResults(app: AppContext, suiteName: string, results: EvalResult[]): string {
  const dir = join(app.config.arkDir, "evals", "results");
  mkdirSync(dir, { recursive: true });
  const filename = `${suiteName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify({ suite: suiteName, results, timestamp: new Date().toISOString() }, null, 2));
  return path;
}

/** List available eval suites. */
export function listEvalSuites(app: AppContext): string[] {
  const suites: string[] = [];
  const dirs = [join(app.config.arkDir, "evals"), join(process.cwd(), "evals")];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".json") && f !== "results");
      suites.push(...files.map(f => f.replace(".json", "")));
    } catch { /* ignore */ }
  }
  return [...new Set(suites)];
}

/** Generate a summary report from eval results. */
export function summarizeResults(results: EvalResult[]): {
  total: number; passed: number; failed: number; avgScore: number; avgDuration: number;
} {
  const passed = results.filter(r => r.passed).length;
  const avgScore = results.length > 0 ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
  const avgDuration = results.length > 0 ? results.reduce((s, r) => s + r.duration_ms, 0) / results.length : 0;
  return { total: results.length, passed, failed: results.length - passed, avgScore, avgDuration };
}
