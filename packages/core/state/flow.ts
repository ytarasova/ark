/**
 * Flow engine - load YAML definitions, evaluate gates, advance stages.
 *
 * Flows are declarative YAML: ordered stages with gates (auto/manual/condition).
 * Stages are either agent tasks or built-in actions (create PR, merge, etc.).
 * Fork stages split into parallel children.
 *
 * All exported functions accept an AppContext so no caller needs to reach
 * for getApp(). Remote-capable render paths should fetch flow definitions
 * via the Ark JSON-RPC client instead of calling these directly.
 */

import { substituteVars } from "../template.js";
import type { AppContext } from "../app.js";
import { logDebug } from "../observability/structured-log.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Inline flow definition accepted in `spawn.flow` as an alternative to a
 * string name lookup. Useful when an RPC or programmatic caller needs to
 * dispatch a bespoke flow shape without pre-registering a YAML file on disk.
 * Minimum required: `stages`. The `name` field defaults to "inline" if omitted.
 */
export interface InlineFlowSpec {
  name?: string;
  description?: string;
  /** Inputs schema declaration (optional at this layer). */
  inputs?: Record<string, unknown>;
  stages: StageDefinition[];
}

/**
 * Durable checkpoint written to session.config.for_each_checkpoint while a
 * for_each loop is mid-execution. Enables boot-time reconciliation to resume
 * a loop from where it left off after a daemon restart.
 *
 * Write order (commit-before-side-effect):
 *   1. Loop enter: write with next_index=0, items=<resolved>, completed=[].
 *   2. Before iteration i: set in_flight={index:i, ...}, next_index=i+1.
 *   3. After iteration i terminal: clear in_flight. Completed-set is derived
 *      from child-session status on resume (see reconcile logic) rather than
 *      maintained in this struct -- avoids the crash window between child
 *      completion and parent checkpoint update.
 *   4. Loop exit: checkpoint is deleted from session.config.
 */
export interface ForEachCheckpoint {
  /** Name of the for_each stage this checkpoint belongs to. */
  stage_name: string;
  /** Total number of items in the resolved list. */
  total_items: number;
  /**
   * The fully-resolved item list, captured at loop entry. Resume uses this
   * list instead of re-resolving the for_each template so the list cannot
   * drift if inputs change between crash and restart.
   */
  items: unknown[];
  /**
   * Index of the next iteration that has NOT yet been confirmed started.
   * Written BEFORE dispatching iteration i, set to i+1.
   */
  next_index: number;
  /**
   * The iteration currently in-flight when the checkpoint was last written.
   * Present while a child is being dispatched / polled; absent otherwise.
   * On resume: if in_flight is set and the child session is not completed,
   * that iteration is retried.
   */
  in_flight?: {
    index: number;
    /** child session id (spawn mode) */
    child_session_id?: string;
    /** sub-stage name (inline mode) */
    sub_stage_name?: string;
    /** ISO timestamp when this iteration started */
    started_at: string;
  };
}

export interface ForEachSpawnSpec {
  /**
   * Named flow (string -- looked up via app.flows.get) OR an inline flow
   * definition object. Inline flows are registered in the ephemeral overlay
   * on the flow store keyed as "inline-{childId}" so existing stage-lookup
   * paths (getStage, getStageAction) see them without any signature changes.
   */
  flow: string | InlineFlowSpec;
  /**
   * Per-iteration override of the child session's `repo` field. When set, the
   * child session is created with this repo path/URL instead of inheriting the
   * parent's. Templates resolve per-iteration (e.g. "{{repo.repo_path}}").
   * Used by multi-repo for_each (one child per target repo).
   */
  repo?: string;
  /**
   * Per-iteration override of the child session's `branch` field. Combined with
   * `repo`, lets each iteration target a deterministic branch on its own repo
   * (e.g. "feature/pai-31080-pi-event-registry").
   */
  branch?: string;
  /**
   * Per-iteration override of the child session's `workdir` field. Rare;
   * normally the worktree is auto-derived from `repo` + `branch`.
   */
  workdir?: string;
  /** Input map for the child session's task vars. Values may be Nunjucks templates. */
  inputs: Record<string, unknown>;
}

/**
 * Inline agent definition accepted in `stage.agent` as an alternative to a
 * string name lookup. Useful when sage RPCs need to dispatch a bespoke agent
 * shape without pre-registering a YAML file on disk. Minimum required:
 * `runtime` and `system_prompt` (everything else defaults to AgentDefinition
 * defaults or inherits from the runtime YAML).
 */
export interface InlineAgentSpec {
  name?: string;
  description?: string;
  runtime: string;
  model?: string;
  max_turns?: number;
  /** Per-query USD budget cap. Passed as ARK_MAX_BUDGET_USD to the runtime launcher. */
  max_budget_usd?: number;
  system_prompt: string;
  tools?: string[];
  mcp_servers?: (string | Record<string, unknown>)[];
  skills?: string[];
  memories?: string[];
  context?: string[];
  permission_mode?: string;
  env?: Record<string, string>;
  command?: string[];
  task_delivery?: "stdin" | "file" | "arg";
}

export interface StageDefinition {
  name: string;
  type?: "agent" | "action" | "fork";
  /**
   * Either a named agent (looked up via `app.agents.get(name)`) OR an inline
   * agent definition object. Inline definitions skip the agent store and
   * build an AgentDefinition in-place at dispatch time.
   */
  agent?: string | InlineAgentSpec;
  action?: string;
  task?: string; // Template for agent task prompt -- Nunjucks syntax ({{var}}, {% if %}, ...)
  gate: "auto" | "manual" | "condition" | "review";
  autonomy?: "full" | "execute" | "edit" | "read-only";
  on_failure?: string;
  /**
   * for_each + mode:spawn primitive (P2.0a).
   *
   * Iterates the resolved list and spawns one child session per item
   * sequentially. Each child is awaited before the next one starts.
   *
   * Example:
   *   - name: per_repo
   *     for_each: "{{repos}}"
   *     mode: spawn
   *     iteration_var: repo
   *     on_iteration_failure: stop
   *     spawn:
   *       flow: my-flow
   *       inputs:
   *         repo_path: "{{repo.repo_path}}"
   */
  for_each?: string;
  /**
   * for_each execution mode:
   * - "spawn" (default): spawns one child session per iteration.
   * - "inline": runs sub-stages sequentially in the parent session per iteration.
   *   Requires `stages:` (list of sub-stages). No child sessions, no worktree clone.
   */
  mode?: "spawn" | "inline";
  iteration_var?: string;
  on_iteration_failure?: "stop" | "continue";
  spawn?: ForEachSpawnSpec;
  /**
   * Inline sub-stages list. Only meaningful when mode=inline.
   * Each sub-stage is dispatched as a regular agent stage in the parent session,
   * with iteration variables substituted into task and agent fields before dispatch.
   */
  stages?: StageDefinition[];
  /**
   * Outcome-based routing. Maps outcome labels reported by the agent
   * to target stage names. When an agent completes with an `outcome`
   * field, the flow advances to the mapped stage instead of the linear next.
   *
   * Example:
   *   on_outcome:
   *     approved: deploy
   *     rejected: revise
   *     needs_info: clarify
   *
   * If the outcome doesn't match any key, falls back to linear next stage.
   */
  on_outcome?: Record<string, string>;
  optional?: boolean;
  model?: string; // override model for this stage (e.g., "opus" for planning, "haiku" for docs)
  compute?: string; // existing compute target name -- ref, not provisioned
  compute_template?: string; // named compute template to use for this stage
  verify?: string[]; // Scripts that must pass before stage completion
  depends_on?: string[]; // DAG: stage names that must complete before this stage runs
  /**
   * Runtime isolation mode for this stage.
   * - "fresh" (default): each stage gets a fresh runtime -- no --resume from prior stage.
   *   Context is passed structurally via task prompt (PLAN.md, git log, events).
   * - "continue": preserve the previous stage's claude_session_id so the next
   *   dispatch resumes the same conversation.
   */
  isolation?: "fresh" | "continue";
  /**
   * Rework-on-reject behaviour for `gate: "review"` / `"manual"` stages.
   * See `packages/types/flow.ts` StageDefinition for details.
   */
  on_reject?: {
    prompt?: string;
    max_rejections?: number;
  };
  /**
   * Per-iteration USD budget cap for for_each stages. When set, this value is
   * used as the effective ARK_MAX_BUDGET_USD for each inline sub-stage dispatch,
   * or is propagated to child sessions (spawn mode) as their cumulative cap
   * if the inline agent spec does not already declare max_budget_usd.
   */
  max_budget_usd?: number;
  /**
   * Idle timeout (minutes) for `for_each + mode:spawn` child iterations.
   * The deadline resets every time the child's `updated_at` advances, so a
   * child that's actively tool-calling or streaming model output never times
   * out -- this is the cap on a *silent* child. Default 60 minutes.
   */
  child_timeout_minutes?: number;
  // Fork-specific
  strategy?: string;
  max_parallel?: number;
  subtasks?: { name: string; task: string }[];
  /**
   * Secrets to resolve via `app.secrets` and inject as env vars at dispatch.
   * See `packages/types/flow.ts` StageDefinition for semantics.
   */
  secrets?: string[];
}

export interface FlowEdgeDefinition {
  from: string;
  to: string;
  condition?: string; // JS expression evaluated against session data
  label?: string;
}

export interface FlowFileInput {
  description?: string;
  required?: boolean;
  accept?: string;
}

export interface FlowParamInput {
  description?: string;
  required?: boolean;
  default?: string;
  pattern?: string;
}

export interface FlowInputsSchema {
  files?: Record<string, FlowFileInput>;
  params?: Record<string, FlowParamInput>;
}

export interface FlowDefinition {
  name: string;
  description?: string;
  stages: StageDefinition[];
  edges?: FlowEdgeDefinition[];
  inputs?: FlowInputsSchema;
  /**
   * Named connectors (by registry key) that every stage in this flow
   * inherits. See `packages/core/connectors/` for the registry. Resolved
   * at dispatch time into MCP server entries + optional context prefills.
   */
  connectors?: string[];
}

// ── Stage navigation ────────────────────────────────────────────────────────

/** Load a flow by name via the AppContext store.
 *
 * `FlowStore.get` is nominally synchronous (the file-backed store reads from
 * disk synchronously), but the hosted DB-backed store exposes `get` as
 * `T | null | Promise<T | null>` to serve sync callers out of an in-memory
 * cache and fall back to a Promise-returning query on a cache miss. Callers
 * here only need the sync resolution -- a cache miss on the hot startSession
 * path means the RPC dispatch path hasn't warmed the cache yet, which should
 * not happen after the `session/start` handler has run (startSession is
 * synchronous wrt. the flow lookup but lives inside an async RPC). To keep
 * the contract tight, we explicitly swallow Promise returns and treat them
 * as "not loaded yet" -- the caller's next tick will see the cached value.
 */
function loadFlow(app: AppContext, name: string): FlowDefinition | null {
  try {
    const result = app.flows.get(name);
    if (result && typeof (result as { then?: unknown }).then === "function") {
      // Hosted DB store cache miss -- Promise return. Fire-and-forget so
      // the cache warms for the next call; for this call there's nothing
      // to return synchronously.
      void (result as Promise<FlowDefinition | null>).catch((err) => {
        logDebug("session", `flow.loadFlow: async cache-warm failed for flow "${name}"`, {
          flow: name,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      return null;
    }
    return result as FlowDefinition | null;
  } catch {
    return null;
  }
}

export function getStages(app: AppContext, flowName: string): StageDefinition[] {
  return loadFlow(app, flowName)?.stages ?? [];
}

export function getStage(app: AppContext, flowName: string, stageName: string): StageDefinition | null {
  return getStages(app, flowName).find((s) => s.name === stageName) ?? null;
}

/** Alias for getStage - retrieve a single stage definition by flow and stage name. */
export function getStageDefinition(app: AppContext, flowName: string, stageName: string): StageDefinition | null {
  return getStage(app, flowName, stageName);
}

export function getFirstStage(app: AppContext, flowName: string): string | null {
  const stages = getStages(app, flowName);
  return stages[0]?.name ?? null;
}

export function getNextStage(app: AppContext, flowName: string, currentStage: string): string | null {
  const stages = getStages(app, flowName);
  const idx = stages.findIndex((s) => s.name === currentStage);
  return idx >= 0 && idx + 1 < stages.length ? stages[idx + 1].name : null;
}

/**
 * Resolve the next stage using outcome-based routing if available.
 *
 * When the current stage has `on_outcome` and an outcome string is provided,
 * the mapped target stage is returned. Falls back to linear `getNextStage()`
 * when no on_outcome is defined, no outcome is provided, or the outcome
 * doesn't match any key.
 */
export function resolveNextStage(
  app: AppContext,
  flowName: string,
  currentStage: string,
  outcome?: string,
): string | null {
  const stage = getStage(app, flowName, currentStage);
  if (stage?.on_outcome && outcome) {
    const target = stage.on_outcome[outcome];
    if (target) {
      // Validate that target stage exists in the flow
      const targetStage = getStage(app, flowName, target);
      if (targetStage) return target;
    }
  }
  return getNextStage(app, flowName, currentStage);
}

// ── Gate evaluation ─────────────────────────────────────────────────────────

export function evaluateGate(
  app: AppContext,
  flowName: string,
  stageName: string,
  session: { error?: string | null },
): { canProceed: boolean; reason: string } {
  const stage = getStage(app, flowName, stageName);
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
  type: "agent" | "action" | "fork" | "for_each" | "unknown";
  /**
   * For agent-type stages: either the agent name (looked up via the store) or
   * an inline agent definition. Dispatch checks the type and routes
   * accordingly.
   */
  agent?: string | InlineAgentSpec;
  action?: string;
  strategy?: string;
  max_parallel?: number;
  on_failure?: string;
  optional?: boolean;
}

export function getStageAction(app: AppContext, flowName: string, stageName: string): StageAction {
  const stage = getStage(app, flowName, stageName);
  if (!stage) return { type: "unknown" };

  if (stage.for_each !== undefined) {
    return { type: "for_each", on_failure: stage.on_failure, optional: stage.optional };
  }

  if (stage.type === "fork") {
    return {
      type: stage.type,
      agent: stage.agent ?? "implementer",
      strategy: stage.strategy ?? "plan",
      max_parallel: stage.max_parallel ?? 4,
      on_failure: stage.on_failure,
      optional: stage.optional,
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
  const names = new Set(stages.map((s) => s.name));
  for (const stage of stages) {
    if (stage.depends_on) {
      for (const dep of stage.depends_on) {
        if (!names.has(dep)) {
          throw new Error(`Stage '${stage.name}' depends on unknown stage '${dep}'`);
        }
      }
    }
    // Validate on_outcome targets reference real stages
    if (stage.on_outcome) {
      for (const [outcome, target] of Object.entries(stage.on_outcome)) {
        if (!names.has(target)) {
          throw new Error(`Stage '${stage.name}' on_outcome '${outcome}' references unknown stage '${target}'`);
        }
      }
    }
    // Validate for_each stages: exactly one of {spawn, stages} present, consistent with mode
    if (stage.for_each !== undefined) {
      const hasSpawn = stage.spawn !== undefined;
      const hasStages = stage.stages !== undefined && stage.stages.length > 0;
      const mode = stage.mode ?? "spawn";
      if (mode === "spawn" && !hasSpawn) {
        throw new Error(`Stage '${stage.name}' has mode:spawn but no spawn: spec`);
      }
      if (mode === "inline" && !hasStages) {
        throw new Error(`Stage '${stage.name}' has mode:inline but no stages: list`);
      }
      if (hasSpawn && hasStages) {
        throw new Error(`Stage '${stage.name}' has both spawn: and stages: -- use one or the other`);
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
export function getReadyStages(stages: StageDefinition[], completedStages: string[]): StageDefinition[] {
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

/** Resolve a flow by rendering {{ var }} placeholders in stage fields. */
export function resolveFlow(app: AppContext, flowName: string, vars: Record<string, string>): FlowDefinition | null {
  const flow = loadFlow(app, flowName);
  if (!flow) return null;

  return {
    ...flow,
    description: flow.description ? substituteVars(flow.description, vars) : undefined,
    stages: flow.stages.map((stage) => ({
      ...stage,
      task: stage.task ? substituteVars(stage.task, vars) : undefined,
      on_failure: stage.on_failure ? substituteVars(stage.on_failure, vars) : undefined,
    })),
  };
}
