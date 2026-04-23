/**
 * for_each dispatcher -- mode:spawn (P2.0a) and mode:inline (P2.5).
 *
 * mode:spawn -- Iterates a list resolved from session inputs/state and spawns
 * one child session per item sequentially. Each child is awaited before the
 * next one starts.
 *
 * mode:inline -- Iterates a list and runs a fixed list of sub-stages
 * sequentially IN THE PARENT SESSION per iteration. No child sessions, no
 * worktree clone. The parent's worktree is used for all sub-stages.
 *
 * Design constraints (both modes):
 *   - Sequential only (no parallel knob).
 *   - Iteration variable substitution via Nunjucks / substituteVars.
 *   - on_iteration_failure: stop (default) | continue.
 */

import { randomUUID } from "crypto";

import type { DispatchDeps, DispatchResult } from "./types.js";
import type { StageDefinition, InlineFlowSpec } from "../../state/flow.js";
import type { FlowDefinition } from "../../state/flow.js";
import { substituteVars } from "../../template.js";
import { logDebug, logWarn } from "../../observability/structured-log.js";

// ── Budget helpers ────────────────────────────────────────────────────────────

/**
 * Sum the cost_usd reported in all hook_status events of type SessionEnd or
 * StopFailure for the given session (and its children, if childIds are provided).
 *
 * Each hook_status event carries the hook payload in `data`: the relevant fields
 * are `data.hook_event_name` (string) and `data.total_cost_usd` (number).
 *
 * Returns 0.0 when there are no matching events.
 */
async function sumPriorIterationCosts(
  events: Pick<DispatchDeps["events"], "list">,
  sessionId: string,
  childIds?: string[],
): Promise<number> {
  const COST_HOOKS = new Set(["SessionEnd", "StopFailure"]);
  let total = 0;

  const trackIds = [sessionId, ...(childIds ?? [])];
  for (const trackId of trackIds) {
    const evts = await events.list(trackId, { type: "hook_status" });
    for (const evt of evts) {
      const data = evt.data as Record<string, unknown> | null;
      if (!data) continue;
      const hookName = data.hook_event_name as string | undefined;
      if (!hookName || !COST_HOOKS.has(hookName)) continue;
      const cost = data.total_cost_usd;
      if (typeof cost === "number" && Number.isFinite(cost)) {
        total += cost;
      }
    }
  }

  return total;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Flatten an arbitrary value into a flat dotted-key string map so that
 * substituteVars can resolve `{{iterVar.foo}}` templates.
 *
 * - Primitive values (string, number, boolean) are converted to strings.
 * - Objects are flattened recursively with dot-separated paths.
 * - Arrays are stringified at their leaf position.
 */
function flattenItem(prefix: string, value: unknown, out: Record<string, string>): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenItem(prefix ? `${prefix}.${k}` : k, v, out);
    }
    return;
  }
  out[prefix] = String(value);
}

/**
 * Build the per-iteration variable map: base session vars + iteration item.
 *
 * The iteration item is flattened under `iterVar` so templates like
 * `{{repo.repo_path}}` (where iterVar="repo") resolve correctly.
 */
function buildIterationVars(baseVars: Record<string, string>, iterVar: string, item: unknown): Record<string, string> {
  const extra: Record<string, string> = {};
  flattenItem(iterVar, item, extra);
  // Also expose the raw item as the iterVar key (serialised) so `{{item}}`
  // resolves to the stringified value for primitive lists.
  if (!(iterVar in extra)) {
    extra[iterVar] = String(item);
  }
  return { ...baseVars, ...extra };
}

/**
 * Substitute Nunjucks templates in every string-valued leaf of an inputs map.
 * Nested objects and arrays are walked recursively; non-string leaves are
 * kept as-is.
 */
function substituteInputs(inputs: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (typeof v === "string") {
      out[k] = substituteVars(v, vars);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = substituteInputs(v as Record<string, unknown>, vars);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Resolve a dotted path from a nested object. Used to read the list value
 * from session state / config when `for_each` references a nested key.
 */
function resolveDotted(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Substitute Nunjucks templates in the string fields of a StageDefinition.
 * Used by mode:inline to resolve per-iteration templates before dispatching
 * each sub-stage (task, agent.system_prompt, agent.name, etc.).
 *
 * Only the fields that influence dispatch are substituted:
 *   - task
 *   - agent (if InlineAgentSpec): system_prompt, name, description
 * Other fields (gate, name, on_failure) are passed through unchanged.
 */
function substituteStageTemplates(stage: StageDefinition, vars: Record<string, string>): StageDefinition {
  const resolved: StageDefinition = { ...stage };

  if (typeof stage.task === "string") {
    resolved.task = substituteVars(stage.task, vars);
  }

  // If agent is an inline spec object, substitute its string fields.
  if (stage.agent && typeof stage.agent === "object") {
    const spec = stage.agent;
    resolved.agent = {
      ...spec,
      ...(spec.name ? { name: substituteVars(spec.name, vars) } : {}),
      ...(spec.description ? { description: substituteVars(spec.description, vars) } : {}),
      system_prompt: substituteVars(spec.system_prompt, vars),
    };
  }

  return resolved;
}

// ── ForEachDispatcher ────────────────────────────────────────────────────────

/** Milliseconds between polls when waiting for a child session to finish. */
const CHILD_POLL_INTERVAL_MS = 250;
/** Maximum time to wait for a single child session to reach terminal state. */
const CHILD_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Callback for dispatching a single inline sub-stage against the parent
 * session's worktree. Implemented by CoreDispatcher and injected here so
 * ForEachDispatcher doesn't need to import the full agent-dispatch pipeline.
 *
 * The callback receives the parent sessionId, the resolved sub-stage definition
 * (already template-substituted), and the iteration vars used for the sub-stage.
 * It should launch the agent, wait for terminal, and return ok/failed.
 */
export interface DispatchInlineSubStageCb {
  (sessionId: string, resolvedSubStage: StageDefinition, iterVars: Record<string, string>): Promise<DispatchResult>;
}

export class ForEachDispatcher {
  constructor(
    private readonly deps: Pick<DispatchDeps, "sessions" | "events" | "flows" | "dispatchChild"> & {
      /** Required only for mode:inline sub-stage dispatch. */
      dispatchInlineSubStage?: DispatchInlineSubStageCb;
    },
  ) {}

  /**
   * Dispatcher switch: routes to spawn or inline based on stageDef.mode.
   * Default (omitted) is spawn for backward compat with P2.0a.
   */
  async dispatchForEach(
    sessionId: string,
    stageDef: StageDefinition,
    /** Pre-built flat session var map (ticket, summary, inputs.*, etc.) */
    sessionVars: Record<string, string>,
  ): Promise<DispatchResult> {
    const mode = stageDef.mode ?? "spawn";
    if (mode === "inline") {
      return this.dispatchForEachInline(sessionId, stageDef, sessionVars);
    }
    return this.dispatchForEachSpawn(sessionId, stageDef, sessionVars);
  }

  /**
   * Execute a `for_each + mode:spawn` stage.
   *
   * Steps:
   *   1. Resolve the list from the session's input vars using the `for_each` template.
   *   2. For each item (sequentially):
   *      a. Flatten item into iteration vars.
   *      b. Substitute `spawn.inputs` templates.
   *      c. Create a child session for the target flow.
   *      d. Dispatch the child.
   *      e. Wait for the child to reach a terminal state.
   *      f. Handle failure per `on_iteration_failure`.
   *   3. Return ok when the loop finishes (or stops on failure).
   */
  async dispatchForEachSpawn(
    sessionId: string,
    stageDef: StageDefinition,
    /** Pre-built flat session var map (ticket, summary, inputs.*, etc.) */
    sessionVars: Record<string, string>,
  ): Promise<DispatchResult> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    const forEachExpr = stageDef.for_each!;
    const iterVar = stageDef.iteration_var ?? "item";
    const onIterFailure = stageDef.on_iteration_failure ?? "stop";
    const spawnSpec = stageDef.spawn;

    if (!spawnSpec) {
      return { ok: false, message: `Stage '${stageDef.name}' has for_each but no spawn spec` };
    }

    // Resolve the list. The for_each expression may be a plain template like
    // `{{repos}}` or `{{inputs.params.repos}}`. We evaluate it to a string
    // and then parse as JSON (for arrays) or treat as a comma-separated list.
    let items: unknown[];
    try {
      items = resolveForEachList(forEachExpr, sessionVars, session);
    } catch (err: any) {
      return { ok: false, message: `for_each: failed to resolve list: ${err.message}` };
    }

    if (items.length === 0) {
      await this.deps.events.log(sessionId, "for_each_complete", {
        stage: session.stage,
        actor: "system",
        data: { total: 0, succeeded: 0, failed: 0, note: "empty list -- no iterations" },
      });
      return { ok: true, message: "for_each: empty list -- stage complete" };
    }

    const flowLabel = typeof spawnSpec.flow === "string" ? spawnSpec.flow : (spawnSpec.flow.name ?? "inline");
    await this.deps.events.log(sessionId, "for_each_start", {
      stage: session.stage,
      actor: "system",
      data: { total: items.length, flow: flowLabel, iterVar },
    });

    const forkGroup = randomUUID().slice(0, 8);
    let succeeded = 0;
    let failedCount = 0;

    // Cumulative budget cap set on the session (via session.config.max_budget_usd).
    const sessionCap = (session.config?.max_budget_usd as number | undefined) ?? null;
    // Collect child IDs spawned so far so we can sum their costs too.
    const spawnedChildIds: string[] = [];

    for (let i = 0; i < items.length; i++) {
      // -- Cumulative budget check (before spawning next iteration) --
      if (sessionCap !== null) {
        const cumulative = await sumPriorIterationCosts(this.deps.events, sessionId, spawnedChildIds);
        if (cumulative >= sessionCap) {
          await this.deps.events.log(sessionId, "for_each_budget_exceeded", {
            stage: session.stage,
            actor: "system",
            data: { cumulative_cost_usd: cumulative, cap_usd: sessionCap, next_iteration: i },
          });
          await this.deps.sessions.update(sessionId, {
            status: "failed",
            error: `budget exceeded: $${cumulative.toFixed(4)} >= cap $${sessionCap}`,
          });
          return {
            ok: false,
            message: `for_each: budget exceeded at iteration ${i}: $${cumulative.toFixed(4)} >= cap $${sessionCap}`,
          };
        }
      }

      const item = items[i];
      const iterVars = buildIterationVars(sessionVars, iterVar, item);
      const resolvedInputs = substituteInputs(spawnSpec.inputs, iterVars);

      // Per-iteration overrides for session-row fields (repo / branch / workdir).
      // Lets multi-repo for_each spawn each child against a different target repo
      // on its own deterministic branch.
      const resolvedRepo = spawnSpec.repo ? substituteVars(spawnSpec.repo, iterVars) : undefined;
      const resolvedBranch = spawnSpec.branch ? substituteVars(spawnSpec.branch, iterVars) : undefined;
      const resolvedWorkdir = spawnSpec.workdir ? substituteVars(spawnSpec.workdir, iterVars) : undefined;

      // Effective per-iteration cap: stage-level max_budget_usd overrides the
      // inherited session cap. This is set on the child session's config so the
      // child's own for_each (if any) also respects it.
      const iterBudget = stageDef.max_budget_usd ?? null;

      // Spawn a child session for this iteration (string name or inline object)
      const spawnResult = await this.spawnChild(sessionId, forkGroup, spawnSpec.flow, resolvedInputs, i, {
        repo: resolvedRepo,
        branch: resolvedBranch,
        workdir: resolvedWorkdir,
        iterBudget,
      });
      if (!spawnResult.ok) {
        failedCount++;
        const msg = `for_each iteration ${i}: spawn failed: ${spawnResult.message}`;
        await this.deps.events.log(sessionId, "for_each_iteration_failed", {
          stage: session.stage,
          actor: "system",
          data: { index: i, item: JSON.stringify(item), reason: spawnResult.message },
        });
        if (onIterFailure === "stop") {
          return { ok: false, message: msg };
        }
        logWarn("session", msg, { sessionId, iteration: i });
        continue;
      }

      const childId = spawnResult.childId;
      spawnedChildIds.push(childId);

      await this.deps.events.log(sessionId, "for_each_iteration_start", {
        stage: session.stage,
        actor: "system",
        data: { index: i, childId, flow: flowLabel, inputs: resolvedInputs },
      });

      // Dispatch the child
      const dispatchResult = await this.deps.dispatchChild(childId);
      if (!dispatchResult.ok) {
        failedCount++;
        await this.deps.events.log(sessionId, "for_each_iteration_failed", {
          stage: session.stage,
          actor: "system",
          data: { index: i, childId, reason: `dispatch failed: ${dispatchResult.message}` },
        });
        if (onIterFailure === "stop") {
          return { ok: false, message: `for_each iteration ${i}: dispatch failed: ${dispatchResult.message}` };
        }
        logWarn("session", `for_each iteration ${i}: dispatch failed`, { sessionId, childId, iteration: i });
        continue;
      }

      // Wait for the child to reach a terminal state
      const terminalStatus = await this.waitForChild(childId);

      if (terminalStatus === "failed") {
        failedCount++;
        await this.deps.events.log(sessionId, "for_each_iteration_failed", {
          stage: session.stage,
          actor: "system",
          data: { index: i, childId, reason: "child session failed" },
        });
        if (onIterFailure === "stop") {
          return {
            ok: false,
            message: `for_each iteration ${i}: child session ${childId} failed`,
          };
        }
        logWarn("session", `for_each iteration ${i}: child failed, continuing`, { sessionId, childId, iteration: i });
        continue;
      }

      if (terminalStatus === "timeout") {
        failedCount++;
        await this.deps.events.log(sessionId, "for_each_iteration_failed", {
          stage: session.stage,
          actor: "system",
          data: { index: i, childId, reason: "child session timed out waiting for terminal state" },
        });
        if (onIterFailure === "stop") {
          return {
            ok: false,
            message: `for_each iteration ${i}: child session ${childId} timed out`,
          };
        }
        logWarn("session", `for_each iteration ${i}: child timed out, continuing`, {
          sessionId,
          childId,
          iteration: i,
        });
        continue;
      }

      succeeded++;
      await this.deps.events.log(sessionId, "for_each_iteration_complete", {
        stage: session.stage,
        actor: "system",
        data: { index: i, childId, status: terminalStatus },
      });
      logDebug("session", `for_each iteration ${i}: complete`, { sessionId, childId });
    }

    await this.deps.events.log(sessionId, "for_each_complete", {
      stage: session.stage,
      actor: "system",
      data: { total: items.length, succeeded, failed: failedCount },
    });

    return {
      ok: true,
      message: `for_each: ${items.length} iterations complete (${succeeded} succeeded, ${failedCount} failed)`,
    };
  }

  /**
   * Execute a `for_each + mode:inline` stage.
   *
   * For each item in the resolved list, runs every sub-stage in `stageDef.stages`
   * sequentially IN THE PARENT SESSION. No child sessions are created; the parent's
   * worktree is reused for all sub-stages.
   *
   * Steps per iteration:
   *   1. Build iteration vars (base session vars + flattened iteration item).
   *   2. For each sub-stage: substitute templates in task and agent fields.
   *   3. Dispatch the resolved sub-stage via the injected `dispatchInlineSubStage` callback.
   *   4. Apply on_iteration_failure policy on failure.
   */
  async dispatchForEachInline(
    sessionId: string,
    stageDef: StageDefinition,
    sessionVars: Record<string, string>,
  ): Promise<DispatchResult> {
    const dispatchSubStage = this.deps.dispatchInlineSubStage;
    if (!dispatchSubStage) {
      return { ok: false, message: "mode:inline requires dispatchInlineSubStage callback -- not wired" };
    }

    const session = await this.deps.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    const forEachExpr = stageDef.for_each!;
    const iterVar = stageDef.iteration_var ?? "item";
    const onIterFailure = stageDef.on_iteration_failure ?? "stop";
    const subStages = stageDef.stages ?? [];

    if (subStages.length === 0) {
      return { ok: false, message: `Stage '${stageDef.name}' has mode:inline but no stages defined` };
    }

    let items: unknown[];
    try {
      items = resolveForEachList(forEachExpr, sessionVars, session);
    } catch (err: any) {
      return { ok: false, message: `for_each: failed to resolve list: ${err.message}` };
    }

    if (items.length === 0) {
      await this.deps.events.log(sessionId, "for_each_complete", {
        stage: session.stage,
        actor: "system",
        data: { total: 0, succeeded: 0, failed: 0, note: "empty list -- no iterations" },
      });
      return { ok: true, message: "for_each: empty list -- stage complete" };
    }

    await this.deps.events.log(sessionId, "for_each_start", {
      stage: session.stage,
      actor: "system",
      data: { total: items.length, mode: "inline", iterVar, subStageCount: subStages.length },
    });

    let succeeded = 0;
    let failedCount = 0;

    // Cumulative budget cap set on the session (via session.config.max_budget_usd).
    const sessionCap = (session.config?.max_budget_usd as number | undefined) ?? null;

    for (let i = 0; i < items.length; i++) {
      // -- Cumulative budget check (before dispatching next iteration) --
      if (sessionCap !== null) {
        const cumulative = await sumPriorIterationCosts(this.deps.events, sessionId);
        if (cumulative >= sessionCap) {
          await this.deps.events.log(sessionId, "for_each_budget_exceeded", {
            stage: session.stage,
            actor: "system",
            data: { cumulative_cost_usd: cumulative, cap_usd: sessionCap, next_iteration: i },
          });
          await this.deps.sessions.update(sessionId, {
            status: "failed",
            error: `budget exceeded: $${cumulative.toFixed(4)} >= cap $${sessionCap}`,
          });
          return {
            ok: false,
            message: `for_each: budget exceeded at iteration ${i}: $${cumulative.toFixed(4)} >= cap $${sessionCap}`,
          };
        }
      }

      const item = items[i];
      const iterVars = buildIterationVars(sessionVars, iterVar, item);

      await this.deps.events.log(sessionId, "for_each_iteration_start", {
        stage: session.stage,
        actor: "system",
        data: { index: i, item: JSON.stringify(item), mode: "inline" },
      });

      let iterationFailed = false;

      for (const subStage of subStages) {
        // Substitute iteration vars into all string fields of the sub-stage.
        // Propagate stage-level max_budget_usd to the resolved sub-stage if the
        // sub-stage's inline agent does not already declare its own budget.
        const resolvedSubStage = substituteStageTemplates(subStage, iterVars);
        if (
          stageDef.max_budget_usd !== undefined &&
          resolvedSubStage.agent &&
          typeof resolvedSubStage.agent === "object"
        ) {
          if ((resolvedSubStage.agent as { max_budget_usd?: number }).max_budget_usd === undefined) {
            (resolvedSubStage.agent as { max_budget_usd?: number }).max_budget_usd = stageDef.max_budget_usd;
          }
        }

        const subResult = await dispatchSubStage(sessionId, resolvedSubStage, iterVars);

        if (!subResult.ok) {
          iterationFailed = true;
          await this.deps.events.log(sessionId, "for_each_iteration_failed", {
            stage: session.stage,
            actor: "system",
            data: { index: i, subStage: subStage.name, reason: subResult.message },
          });
          logWarn("session", `for_each inline iteration ${i} sub-stage '${subStage.name}' failed`, {
            sessionId,
            iteration: i,
            subStage: subStage.name,
          });
          break; // Stop sub-stages for this iteration on first failure
        }

        await this.deps.events.log(sessionId, "for_each_substage_complete", {
          stage: session.stage,
          actor: "system",
          data: { index: i, subStage: subStage.name },
        });
      }

      if (iterationFailed) {
        failedCount++;
        if (onIterFailure === "stop") {
          return {
            ok: false,
            message: `for_each inline: iteration ${i} failed -- stopping`,
          };
        }
        continue;
      }

      succeeded++;
      await this.deps.events.log(sessionId, "for_each_iteration_complete", {
        stage: session.stage,
        actor: "system",
        data: { index: i, mode: "inline" },
      });
      logDebug("session", `for_each inline iteration ${i}: complete`, { sessionId });
    }

    await this.deps.events.log(sessionId, "for_each_complete", {
      stage: session.stage,
      actor: "system",
      data: { total: items.length, succeeded, failed: failedCount, mode: "inline" },
    });

    return {
      ok: true,
      message: `for_each inline: ${items.length} iterations complete (${succeeded} succeeded, ${failedCount} failed)`,
    };
  }

  /** Create a child session for one iteration. */
  private async spawnChild(
    parentId: string,
    forkGroup: string,
    flowRef: string | InlineFlowSpec,
    inputs: Record<string, unknown>,
    index: number,
    overrides?: { repo?: string; branch?: string; workdir?: string; iterBudget?: number | null },
  ): Promise<{ ok: true; childId: string } | { ok: false; message: string }> {
    const parent = await this.deps.sessions.get(parentId);
    if (!parent) return { ok: false, message: "Parent session not found" };

    let flowDef: FlowDefinition | null;
    let flowName: string;

    if (typeof flowRef === "string") {
      // Named flow -- look up from the store (file-backed or DB-backed).
      flowName = flowRef;
      flowDef = this.deps.flows.get(flowName);
      if (!flowDef) return { ok: false, message: `Flow '${flowName}' not found` };
    } else {
      // Inline flow object. Validate minimum shape.
      if (!flowRef.stages || flowRef.stages.length === 0) {
        return { ok: false, message: "Inline flow must have at least one stage" };
      }
      // Build a FlowDefinition-compatible object from the inline spec.
      // We defer assigning the synthetic name until we know the childId.
      flowDef = {
        name: flowRef.name ?? "inline",
        description: flowRef.description,
        stages: flowRef.stages,
      } as FlowDefinition;
      // Placeholder -- will be overwritten to "inline-{childId}" below.
      flowName = flowRef.name ?? "inline";
    }

    const firstStage = flowDef.stages[0]?.name ?? null;

    const summary = (inputs.summary as string | undefined) ?? `${flowName} iteration ${index}`;
    const child = await this.deps.sessions.create({
      summary,
      // Per-iteration overrides win over parent inheritance. Multi-repo for_each
      // uses this to spawn each child against a different target repo on its own
      // deterministic branch.
      repo: overrides?.repo ?? parent.repo ?? undefined,
      ...(overrides?.branch ? { branch: overrides.branch } : {}),
      compute_name: parent.compute_name || undefined,
      workdir: overrides?.workdir ?? parent.workdir ?? undefined,
      group_name: parent.group_name || undefined,
      // `flow` is set after we know childId for inline flows. Inline flows also
      // persist the definition under config.inline_flow for daemon-restart rehydration.
      flow: flowName,
      config: {
        inputs,
        for_each_parent: parentId,
        for_each_index: index,
        // Propagate stage-level per-iteration budget cap to child sessions so
        // the child's own for_each dispatch (if any) also enforces it.
        ...(overrides?.iterBudget !== undefined && overrides.iterBudget !== null
          ? { max_budget_usd: overrides.iterBudget }
          : {}),
      },
    });

    // For inline flows: register under "inline-{childId}" so the existing
    // getStage / getStageAction paths (which only know the flow name) can find
    // the definition without any signature changes. Persist the definition on
    // the session row so it survives daemon restart.
    if (typeof flowRef !== "string") {
      const syntheticName = `inline-${child.id}`;
      flowName = syntheticName;
      const finalDef: FlowDefinition = { ...flowDef, name: syntheticName };

      // Register in the ephemeral overlay so lookups work immediately.
      this.deps.flows.registerInline?.(syntheticName, finalDef);

      // Update the child session's flow field and persist the definition.
      await this.deps.sessions.update(child.id, {
        flow: syntheticName,
      });
      await this.deps.sessions.mergeConfig(child.id, { inline_flow: finalDef });
    }

    await this.deps.sessions.update(child.id, {
      parent_id: parentId,
      fork_group: forkGroup,
      stage: firstStage,
      status: "ready",
    });

    return { ok: true, childId: child.id };
  }

  /**
   * Poll until the child session reaches a terminal state.
   * Returns the terminal status ("completed" | "failed") or "timeout".
   */
  private async waitForChild(childId: string): Promise<"completed" | "failed" | "timeout"> {
    const deadline = Date.now() + CHILD_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const child = await this.deps.sessions.get(childId);
      if (!child) return "failed";
      if (child.status === "completed") return "completed";
      if (child.status === "failed") return "failed";
      // stopped / archived are also terminal -- treat as failure
      if (child.status === "stopped" || child.status === "archived") return "failed";
      await Bun.sleep(CHILD_POLL_INTERVAL_MS);
    }
    return "timeout";
  }
}

// ── List resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the `for_each` expression to a JavaScript array.
 *
 * Resolution order:
 *   1. If the expression is a plain key (no `{{`) look it up directly in the
 *      session config/inputs as a JSON-parsed value.
 *   2. Otherwise render it as a Nunjucks template against `sessionVars`.
 *      The rendered string is then parsed:
 *        - If it starts with `[` -> JSON.parse.
 *        - Otherwise split on newlines or commas (trimmed, filtered empty).
 *
 * This lets both `"{{repos}}"` (where `repos` is a JSON-array string) and
 * plain `"myKey"` (a direct config lookup) work without ceremony.
 */
function resolveForEachList(
  expr: string,
  sessionVars: Record<string, string>,
  session: Record<string, unknown>,
): unknown[] {
  // Attempt direct config lookup when the expr is a simple identifier.
  if (!/\{\{/.test(expr)) {
    const direct = resolveDotted((session.config as Record<string, unknown>) ?? {}, expr);
    if (direct !== undefined) return coerceToArray(direct);
    const fromVars = sessionVars[expr];
    if (fromVars !== undefined) return coerceToArray(fromVars);
  }

  // Render as template
  const rendered = substituteVars(expr, sessionVars);

  // Detect unresolved placeholder -- the template preserved its `{{...}}`
  if (rendered.startsWith("{{") && rendered.endsWith("}}")) {
    // Try direct config lookup using the inner key
    const inner = rendered.slice(2, -2).trim();
    const configVal = resolveDotted(((session as any).config as Record<string, unknown>) ?? {}, inner);
    if (configVal !== undefined) return coerceToArray(configVal);
    throw new Error(`Cannot resolve for_each list: '${expr}' rendered to unresolvable '${rendered}'`);
  }

  return coerceToArray(rendered);
}

function coerceToArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to split
      }
    }
    return trimmed
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // scalar -- wrap in single-element array
  return [value];
}
