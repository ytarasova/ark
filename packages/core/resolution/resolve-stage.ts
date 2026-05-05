/**
 * Stage resolution pipeline.
 *
 * Given a flow + stage + session, walk the three-level agent binding
 * (stage.agent -> agent.runtime -> agent.model) and materialize every node
 * into its concrete definition. Each level accepts either a string (a
 * name-registry lookup) or an inline object (a literal definition). The
 * returned `ResolvedStage` is ready for the executor -- no further lookups
 * are needed.
 *
 * Failure modes are fatal with clear messages:
 *   - Agent "x" not found
 *   - Runtime "x" not found
 *   - Model "x" not found in catalog
 *   - Agent "x" has no model
 *
 * `launch.ts` receives `resolvedSlug` -- the already-concrete provider slug
 * for whatever gateway/runtime is in play. This module is the ONE place that
 * consults the model catalog; everything downstream is string-in / string-out.
 */

import { substituteVars, buildSessionVars } from "../template.js";
import { findProjectRoot } from "../agent/agent.js";
import { resolveModelFromStore, providerSlugFor } from "../models/resolver.js";
import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import type { AgentDefinition, RuntimeDefinition } from "../../types/agent.js";
import type { ModelDefinition } from "../../types/model.js";
import type { StageDefinition, InlineAgentSpec } from "../services/flow.js";

// ── Inline types ────────────────────────────────────────────────────────────

/**
 * Inline runtime definition accepted on `InlineAgent.runtime`. Mirrors
 * RuntimeDefinition minus the name-registry bookkeeping -- callers pass a
 * literal object, we treat it exactly like a YAML-authored runtime.
 */
export type InlineRuntimeSpec = Omit<RuntimeDefinition, "_source" | "_path">;

/**
 * Inline model definition accepted on `InlineAgent.model`. Mirrors
 * ModelDefinition minus name-registry bookkeeping.
 */
export type InlineModelSpec = Omit<ModelDefinition, "_source" | "_path">;

/**
 * Inline agent definition accepted on `stage.agent`. Extends the existing
 * `InlineAgentSpec` shape from services/flow.ts with support for inline runtime
 * and inline model objects. Uses the same "name OR object" convention.
 */
export interface ExtendedInlineAgentSpec extends Omit<InlineAgentSpec, "runtime" | "model"> {
  runtime: string | InlineRuntimeSpec;
  model?: string | InlineModelSpec;
}

// ── Output type ─────────────────────────────────────────────────────────────

export interface ResolvedStage {
  /** The stage definition that drove this resolution. */
  stage: StageDefinition;
  /** Materialized agent (runtime-merged; ready for the executor). */
  agent: AgentDefinition;
  /** Materialized runtime, either looked up from the store or inline. */
  runtime: RuntimeDefinition;
  /** Materialized model (catalog entry OR inline). Drives `resolvedSlug`. */
  model: ModelDefinition;
  /**
   * Concrete provider slug to hand to the runtime launcher. Resolved via the
   * runtime's declared `provider_key` (or falls back to the runtime's
   * `name`/`type`). If the caller needs a different gateway (e.g. bedrock),
   * the runtime's provider_key should target that gateway.
   */
  resolvedSlug: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Decide which provider key to use for `providerSlugFor(model, key)`. Priority:
 *   1. Runtime's `provider_key` field (if declared)
 *   2. Runtime's name (matches the catalog keys for our shipped runtimes:
 *      `anthropic-direct`, `tf-bedrock`, etc.)
 *   3. Fallback: "anthropic-direct" for anthropic models, else the provider
 *      on the model definition itself.
 *
 * Bedrock compat is keyed on the runtime's compat flag, not the runtime name,
 * so a runtime with `compat: [bedrock]` should ideally set `provider_key:
 * tf-bedrock` in its YAML. Until every runtime carries an explicit key, we
 * use the compat flag as a last-ditch hint.
 */
function pickProviderKey(runtime: RuntimeDefinition, model: ModelDefinition): string {
  const explicit = (runtime as { provider_key?: string }).provider_key;
  if (explicit && typeof explicit === "string") return explicit;

  // Compat-based hint: anything with `bedrock` compat looks up the bedrock
  // slug. This keeps existing agent-sdk.yaml working without adding a new
  // field to every runtime.
  if (runtime.compat?.includes("bedrock") && model.provider_slugs["tf-bedrock"]) {
    return "tf-bedrock";
  }

  // Direct lookups by well-known runtime names.
  if (model.provider_slugs[runtime.name]) return runtime.name;

  // Vendor fallback: the model's declared provider (e.g. "anthropic" ->
  // "anthropic-direct" is the first-class direct key).
  const direct = `${model.provider}-direct`;
  if (model.provider_slugs[direct]) return direct;

  // Last resort: the model's own provider string (matches unusual catalog
  // shapes where provider_slugs is keyed by vendor name).
  return model.provider;
}

// ── Resolvers ───────────────────────────────────────────────────────────────

/**
 * Resolve a model reference (string or inline object) into a concrete
 * ModelDefinition. String refs hit the catalog; object refs are validated and
 * returned verbatim.
 */
function resolveModelRef(app: AppContext, ref: string | InlineModelSpec, projectRoot?: string): ModelDefinition {
  if (typeof ref === "string") {
    return resolveModelFromStore(app.models, ref, projectRoot);
  }
  if (!isObject(ref)) {
    throw new Error(`Model reference must be a string id/alias or an inline object, got ${typeof ref}`);
  }
  if (!ref.id || typeof ref.id !== "string") {
    throw new Error(`Inline model is missing required field "id"`);
  }
  if (!ref.provider_slugs || !isObject(ref.provider_slugs)) {
    throw new Error(`Inline model "${ref.id}" is missing required field "provider_slugs"`);
  }
  if (!ref.provider || typeof ref.provider !== "string") {
    throw new Error(`Inline model "${ref.id}" is missing required field "provider"`);
  }
  return ref as ModelDefinition;
}

/**
 * Resolve a runtime reference into a concrete RuntimeDefinition. Missing
 * named runtimes throw; inline runtimes pass through with only the required
 * fields checked.
 */
function resolveRuntimeRef(app: AppContext, ref: string | InlineRuntimeSpec): RuntimeDefinition {
  if (typeof ref === "string") {
    const hit = app.runtimes.get(ref);
    if (!hit) {
      // Sync stores return null synchronously; promise-returning hosted stores
      // are a distinct branch but the dispatch path already serializes on a
      // cached lookup via FlowStore.get() before we reach here.
      const list = app.runtimes
        .list()
        .map((r) => r.name)
        .sort();
      throw new Error(`Runtime "${ref}" not found. Available: [${list.join(", ")}]`);
    }
    return hit;
  }
  if (!isObject(ref)) {
    throw new Error(`Runtime reference must be a string name or an inline object, got ${typeof ref}`);
  }
  if (!ref.name || typeof ref.name !== "string") {
    throw new Error(`Inline runtime is missing required field "name"`);
  }
  if (!ref.type || typeof ref.type !== "string") {
    throw new Error(`Inline runtime "${ref.name}" is missing required field "type"`);
  }
  return ref as RuntimeDefinition;
}

/**
 * Build a materialized AgentDefinition from a stage ref. The ref is either a
 * named agent (store lookup, substitution, runtime_overrides merge) OR an
 * inline agent object. After this call, `agent.runtime` and `agent.model`
 * have been replaced by the resolved runtime/model entries' identifiers, and
 * the executor can read them as plain strings.
 *
 * Mutation rules:
 *   - Templates in `system_prompt` / `recipe` / `task_prompt` are rendered
 *     against session vars.
 *   - Runtime env is merged first so agent env overrides win.
 *   - `_resolved_runtime_type` is set to the runtime's `type`.
 *   - `runtime_overrides[<runtime.name>]` is shallow-merged if present.
 */
function buildAgent(
  app: AppContext,
  stage: StageDefinition,
  session: Session,
  projectRoot: string | undefined,
): { agentBase: AgentDefinition; agentRef: string | ExtendedInlineAgentSpec } {
  const ref = stage.agent;
  if (ref === undefined || ref === null) {
    throw new Error(`Stage '${stage.name}' has no agent reference`);
  }

  const sessionRecord = session as unknown as Record<string, unknown>;
  const vars = buildSessionVars(sessionRecord);

  if (typeof ref === "string") {
    const agent = app.agents.get(ref, projectRoot);
    if (!agent) {
      throw new Error(`Agent "${ref}" not found`);
    }
    // Render templates that matter at the stage level. Runtime-specific
    // string values inside agent.runtime_config (e.g. goose.recipe paths)
    // are substituted by resolveAgent at agent-load time; only the
    // system_prompt renders here.
    if (agent.system_prompt) agent.system_prompt = substituteVars(agent.system_prompt, vars);
    return { agentBase: agent, agentRef: ref };
  }

  if (!isObject(ref)) {
    throw new Error(`Stage '${stage.name}' agent must be a string name or an inline object`);
  }

  const inlineRef = ref as ExtendedInlineAgentSpec;
  if (!inlineRef.runtime) {
    throw new Error(`Inline agent on stage '${stage.name}' is missing required field "runtime"`);
  }
  if (!inlineRef.system_prompt) {
    throw new Error(`Inline agent on stage '${stage.name}' is missing required field "system_prompt"`);
  }

  const agent: AgentDefinition = {
    name: inlineRef.name ?? "inline",
    description: inlineRef.description ?? "",
    // Model is resolved against the catalog in the next pipeline step; here
    // we carry whatever identifier the caller used. For inline models we
    // stash the id field so downstream executors see a plain string.
    model: typeof inlineRef.model === "string" ? inlineRef.model : (inlineRef.model?.id ?? ""),
    max_turns: inlineRef.max_turns ?? 200,
    system_prompt: substituteVars(inlineRef.system_prompt, vars),
    tools: inlineRef.tools ?? ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    mcp_servers: inlineRef.mcp_servers ?? [],
    skills: inlineRef.skills ?? [],
    memories: inlineRef.memories ?? [],
    context: inlineRef.context ?? [],
    permission_mode: inlineRef.permission_mode ?? "bypassPermissions",
    env: inlineRef.env ?? {},
    runtime: typeof inlineRef.runtime === "string" ? inlineRef.runtime : inlineRef.runtime.name,
    command: inlineRef.command,
    task_delivery: inlineRef.task_delivery,
    _source: "builtin",
  };
  return { agentBase: agent, agentRef: inlineRef };
}

/**
 * Entry point. Resolves the full binding chain for a single stage and returns
 * a ready-to-dispatch `ResolvedStage`.
 */
export function resolveStage(app: AppContext, session: Session, stage: StageDefinition): ResolvedStage {
  const projectRoot = findProjectRoot(session.workdir || session.repo || undefined) ?? undefined;
  const { agentBase, agentRef } = buildAgent(app, stage, session, projectRoot);

  // Runtime ref: either the agent's string name OR an inline object smuggled
  // through an inline agent.
  const runtimeRef: string | InlineRuntimeSpec =
    typeof agentRef === "string" ? (agentBase.runtime ?? "") : (agentRef.runtime as string | InlineRuntimeSpec);
  if (!runtimeRef || (typeof runtimeRef === "string" && runtimeRef.length === 0)) {
    throw new Error(`Agent "${agentBase.name}" has no runtime`);
  }

  const runtime = resolveRuntimeRef(app, runtimeRef);

  // Runtime merge: env + type hint. Runtime's values fill gaps that the
  // agent didn't set; agent wins on conflict (matching the legacy contract).
  const mergedAgent: AgentDefinition = {
    ...agentBase,
    _resolved_runtime_type: runtime.type,
    command: agentBase.command ?? runtime.command,
    task_delivery: agentBase.task_delivery ?? runtime.task_delivery,
    env: { ...(runtime.env ?? {}), ...(agentBase.env ?? {}) },
    runtime: runtime.name,
  };

  // runtime_overrides: shallow-merge the override block for this runtime onto
  // the agent. Matches the pre-rewrite behavior so existing agent YAMLs that
  // declare a per-runtime system_prompt still take effect.
  if (mergedAgent.runtime_overrides && mergedAgent.runtime_overrides[runtime.name]) {
    const override = mergedAgent.runtime_overrides[runtime.name];
    const sessionVars = buildSessionVars(session as unknown as Record<string, unknown>);
    Object.assign(mergedAgent, override);
    if (override.system_prompt) {
      mergedAgent.system_prompt = substituteVars(override.system_prompt, sessionVars);
    }
  }

  // Stage-level model override (legacy stage.model field). Applied BEFORE the
  // catalog lookup so the override is itself resolvable.
  const modelRef: string | InlineModelSpec | undefined = typeof agentRef === "object" ? agentRef.model : undefined;

  // Pick the model ref to resolve. Priority:
  //   1. Stage-level model override (stage.model) -- legacy escape hatch
  //   2. Inline agent's model field (string or object)
  //   3. Agent's own model (the 1:1 binding)
  const resolvedModelRef: string | InlineModelSpec =
    (stage.model as string | undefined) ?? modelRef ?? mergedAgent.model;
  if (!resolvedModelRef) {
    throw new Error(`Agent "${mergedAgent.name}" has no model and no stage.model override`);
  }
  const model = resolveModelRef(app, resolvedModelRef, projectRoot);

  // Replace the agent.model with the concrete catalog id so downstream code
  // (executors, hooks) sees a canonical, unambiguous string.
  mergedAgent.model = model.id;

  // Pick the provider slug matching this runtime/model pair.
  const providerKey = pickProviderKey(runtime, model);
  const resolvedSlug = providerSlugFor(model, providerKey);

  return { stage, agent: mergedAgent, runtime, model, resolvedSlug };
}
