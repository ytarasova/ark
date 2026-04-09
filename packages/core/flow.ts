/**
 * Flow engine - load YAML definitions, evaluate gates, advance stages.
 *
 * Flows are declarative YAML: ordered stages with gates (auto/manual/condition).
 * Stages are either agent tasks or built-in actions (create PR, merge, etc.).
 * Fork stages split into parallel children.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { ARK_DIR } from "./paths.js";
import { substituteVars } from "./template.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface StageDefinition {
  name: string;
  type?: "agent" | "action" | "fork" | "fan_out";
  agent?: string;
  action?: string;
  task?: string;  // Template for agent task prompt — supports {variable} substitution
  gate: "auto" | "manual" | "condition" | "review";
  autonomy?: "full" | "execute" | "edit" | "read-only";
  on_failure?: string;
  optional?: boolean;
  model?: string;  // override model for this stage (e.g., "opus" for planning, "haiku" for docs)
  verify?: string[];  // Scripts that must pass before stage completion
  depends_on?: string[];  // DAG: stage names that must complete before this stage runs
  // Fork/fan_out-specific
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
function USER_DIR() { return join(ARK_DIR(), "flows"); }

// ── Loading ─────────────────────────────────────────────────────────────────

function loadYaml(path: string): Record<string, unknown> {
  return YAML.parse(readFileSync(path, "utf-8")) ?? {};
}

export function loadFlow(name: string): FlowDefinition | null {
  // User overrides builtin
  for (const dir of [USER_DIR(), BUILTIN_DIR]) {
    const path = join(dir, `${name}.yaml`);
    if (existsSync(path)) return loadYaml(path) as unknown as FlowDefinition;
  }
  return null;
}

export function listFlows(): { name: string; description: string; stages: string[]; source: string }[] {
  const result: Map<string, { name: string; description: string; stages: string[]; source: string }> = new Map();

  for (const [dir, source] of [[BUILTIN_DIR, "builtin"], [USER_DIR(), "user"]] as const) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const p = loadYaml(join(dir, file)) as Record<string, unknown>;
      const name = (p.name as string) ?? file.replace(".yaml", "");
      const stages = (Array.isArray(p.stages) ? p.stages : []) as Array<{ name: string }>;
      result.set(name, {
        name,
        description: (p.description as string) ?? "",
        stages: stages.map(s => s.name),
        source,
      });
    }
  }
  return [...result.values()];
}

// ── Save / Delete ──────────────────────────────────────────────────────────

export function saveFlow(flow: FlowDefinition, scope: "global" | "project" = "global", projectRoot?: string): void {
  const dir = scope === "project" && projectRoot ? join(projectRoot, ".ark", "flows") : USER_DIR();
  mkdirSync(dir, { recursive: true });
  const { ...data } = flow;
  writeFileSync(join(dir, `${flow.name}.yaml`), YAML.stringify(data));
}

export function deleteFlow(name: string, scope: "global" | "project" = "global", projectRoot?: string): boolean {
  const dir = scope === "project" && projectRoot ? join(projectRoot, ".ark", "flows") : USER_DIR();
  const path = join(dir, `${name}.yaml`);
  if (existsSync(path)) { unlinkSync(path); return true; }
  return false;
}

// ── Stage navigation ────────────────────────────────────────────────────────

export function getStages(flowName: string): StageDefinition[] {
  return loadFlow(flowName)?.stages ?? [];
}

export function getStage(flowName: string, stageName: string): StageDefinition | null {
  return getStages(flowName).find((s) => s.name === stageName) ?? null;
}

/** Alias for getStage - retrieve a single stage definition by flow and stage name. */
export function getStageDefinition(flowName: string, stageName: string): StageDefinition | null {
  return getStage(flowName, stageName);
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
    case "review":
      return { canProceed: false, reason: "review gate: awaiting PR approval" };
    default:
      return { canProceed: false, reason: `Unknown gate: ${stage.gate}` };
  }
}

// ── Stage action info ───────────────────────────────────────────────────────

export interface StageAction {
  type: "agent" | "action" | "fork" | "fan_out" | "unknown";
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

  if (stage.type === "fork" || stage.type === "fan_out") {
    return {
      type: stage.type, agent: stage.agent ?? "implementer",
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

// ── DAG validation ──────────────────────────────────────────────────────────

/** Validate that stages with depends_on form a valid DAG (no cycles, all refs exist). Throws on invalid. */
export function validateDAG(stages: StageDefinition[]): void {
  const names = new Set(stages.map(s => s.name));
  for (const stage of stages) {
    if (!stage.depends_on) continue;
    for (const dep of stage.depends_on) {
      if (!names.has(dep)) {
        throw new Error(`Stage '${stage.name}' depends on unknown stage '${dep}'`);
      }
    }
  }

  // Topological sort cycle detection (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of stages) {
    inDegree.set(s.name, 0);
    adj.set(s.name, []);
  }
  for (const s of stages) {
    if (!s.depends_on) continue;
    for (const dep of s.depends_on) {
      adj.get(dep)!.push(s.name);
      inDegree.set(s.name, (inDegree.get(s.name) ?? 0) + 1);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([n]) => n);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const next of adj.get(node) ?? []) {
      const d = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited !== stages.length) {
    throw new Error("Flow stages contain a dependency cycle");
  }
}

// ── DAG resolution ─────────────────────────────────────────────────────────

/**
 * Given a list of stages and which stages are completed,
 * return the stages that are ready to execute (all dependencies met).
 * Stages without depends_on default to depending on the previous stage (linear).
 */
export function getReadyStages(
  stages: StageDefinition[],
  completedStages: string[],
): StageDefinition[] {
  const completed = new Set(completedStages);
  const ready: StageDefinition[] = [];

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    if (completed.has(stage.name)) continue;

    let deps = stage.depends_on;

    // If no depends_on, default to linear: depend on previous stage
    if (!deps && i > 0) {
      deps = [stages[i - 1].name];
    }

    // No deps (first stage) or all deps met
    if (!deps || deps.length === 0 || deps.every((d) => completed.has(d))) {
      ready.push(stage);
    }
  }

  return ready;
}

// ── Template substitution ────────────────────────────────────────────────────

/** Resolve a flow by substituting {variables} in stage fields. */
export function resolveFlow(flowName: string, vars: Record<string, string>): FlowDefinition | null {
  const flow = loadFlow(flowName);
  if (!flow) return null;

  return {
    ...flow,
    description: flow.description ? substituteVars(flow.description, vars) : undefined,
    stages: flow.stages.map(stage => ({
      ...stage,
      task: stage.task ? substituteVars(stage.task, vars) : undefined,
      on_failure: stage.on_failure ? substituteVars(stage.on_failure, vars) : undefined,
    })),
  };
}
