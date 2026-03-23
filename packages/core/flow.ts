/**
 * Flow engine - load YAML definitions, evaluate gates, advance stages.
 *
 * Flows are declarative YAML: ordered stages with gates (auto/manual/condition).
 * Stages are either agent tasks or built-in actions (create PR, merge, etc.).
 * Fork stages split into parallel children.
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { ARK_DIR } from "./store.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface StageDefinition {
  name: string;
  type?: "agent" | "action" | "fork";
  agent?: string;
  action?: string;
  gate: "auto" | "manual" | "condition";
  on_failure?: string;
  optional?: boolean;
  // Fork-specific
  strategy?: string;
  max_parallel?: number;
  subtasks?: { name: string; task: string }[];
}

export interface FlowDefinition {
  name: string;
  description?: string;
  stages: StageDefinition[];
}

// ── Paths ───────────────────────────────────────────────────────────────────

import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "..", "..", "flows", "definitions");
const USER_DIR = join(ARK_DIR, "flows");

// ── Loading ─────────────────────────────────────────────────────────────────

function loadYaml(path: string): Record<string, unknown> {
  return YAML.parse(readFileSync(path, "utf-8")) ?? {};
}

export function loadFlow(name: string): FlowDefinition | null {
  // User overrides builtin
  for (const dir of [USER_DIR, BUILTIN_DIR]) {
    const path = join(dir, `${name}.yaml`);
    if (existsSync(path)) return loadYaml(path) as unknown as FlowDefinition;
  }
  return null;
}

export function listFlows(): { name: string; description: string; stages: string[]; source: string }[] {
  const result: Map<string, { name: string; description: string; stages: string[]; source: string }> = new Map();

  for (const [dir, source] of [[BUILTIN_DIR, "builtin"], [USER_DIR, "user"]] as const) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const p = loadYaml(join(dir, file)) as any;
      const name = p.name ?? file.replace(".yaml", "");
      result.set(name, {
        name,
        description: p.description ?? "",
        stages: (p.stages ?? []).map((s: any) => s.name),
        source,
      });
    }
  }
  return [...result.values()];
}

// ── Stage navigation ────────────────────────────────────────────────────────

export function getStages(flowName: string): StageDefinition[] {
  return loadFlow(flowName)?.stages ?? [];
}

export function getStage(flowName: string, stageName: string): StageDefinition | null {
  return getStages(flowName).find((s) => s.name === stageName) ?? null;
}

export function getFirstStage(flowName: string): string | null {
  const stages = getStages(flowName);
  return stages[0]?.name ?? null;
}

export function getNextStage(flowName: string, currentStage: string): string | null {
  const stages = getStages(flowName);
  const idx = stages.findIndex((s) => s.name === currentStage);
  return idx >= 0 && idx + 1 < stages.length ? stages[idx + 1].name : null;
}

// ── Gate evaluation ─────────────────────────────────────────────────────────

export function evaluateGate(
  flowName: string, stageName: string, session: { error?: string | null },
): { canProceed: boolean; reason: string } {
  const stage = getStage(flowName, stageName);
  if (!stage) return { canProceed: false, reason: `Stage '${stageName}' not found` };

  switch (stage.gate) {
    case "auto":
      return session.error
        ? { canProceed: false, reason: `Stage has error: ${session.error}` }
        : { canProceed: true, reason: "auto gate passed" };
    case "manual":
      return { canProceed: false, reason: "manual gate: awaiting human approval" };
    case "condition":
      return { canProceed: true, reason: "condition evaluated" };
    default:
      return { canProceed: false, reason: `Unknown gate: ${stage.gate}` };
  }
}

// ── Stage action info ───────────────────────────────────────────────────────

export interface StageAction {
  type: "agent" | "action" | "fork" | "unknown";
  agent?: string;
  action?: string;
  strategy?: string;
  max_parallel?: number;
  on_failure?: string;
  optional?: boolean;
}

export function getStageAction(flowName: string, stageName: string): StageAction {
  const stage = getStage(flowName, stageName);
  if (!stage) return { type: "unknown" };

  if (stage.type === "fork") {
    return {
      type: "fork", agent: stage.agent ?? "implementer",
      strategy: stage.strategy ?? "plan", max_parallel: stage.max_parallel ?? 4,
      on_failure: stage.on_failure, optional: stage.optional,
    };
  }
  if (stage.action) {
    return { type: "action", action: stage.action, on_failure: stage.on_failure, optional: stage.optional };
  }
  if (stage.agent) {
    return { type: "agent", agent: stage.agent, on_failure: stage.on_failure, optional: stage.optional };
  }
  return { type: "unknown" };
}
