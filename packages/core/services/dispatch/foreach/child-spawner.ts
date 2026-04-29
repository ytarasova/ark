/**
 * for_each child-session spawner + terminal-state waiter.
 *
 * Pulled out of ForEachDispatcher so the main orchestrator focuses on the
 * iteration loop while this collaborator handles child lifecycle concerns:
 *
 *   - resolving a `spawn.flow` that may be either a named reference or an
 *     inline FlowDefinition,
 *   - creating the child session row with per-iteration overrides (repo,
 *     branch, workdir, iteration budget),
 *   - registering synthetic inline flow definitions in the ephemeral flow
 *     store so daemon restart can rehydrate them,
 *   - polling the child session until it reaches a terminal state.
 */

import type { DispatchDeps } from "../types.js";
import type { FlowDefinition, InlineFlowSpec } from "../../../state/flow.js";

/** Milliseconds between polls when waiting for a child session to finish. */
const CHILD_POLL_INTERVAL_MS = 250;
/**
 * Default *idle* timeout for waiting on a child session. The deadline resets
 * on every observed change to `child.updated_at` -- a child that's actively
 * progressing never times out, but a genuinely silent child gives up after
 * this window. Override per-stage with `child_timeout_minutes:` in the YAML.
 *
 * Pre-2026-04-25 this was a hard 30-minute wall-clock timeout, which raced
 * against active children -- a long stream with no events for 30 min would
 * trigger the timeout while the child was still doing useful work, the
 * parent would mark the iteration "timed out, continuing" while the orphan
 * child kept running and committed/pushed minutes later.
 */
const CHILD_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

export interface SpawnOverrides {
  repo?: string;
  branch?: string;
  workdir?: string;
  iterBudget?: number | null;
}

export type SpawnChildResult = { ok: true; childId: string } | { ok: false; message: string };

/**
 * Child-session spawner / waiter. Holds narrow deps references and exposes
 * two operations: spawn a child for one iteration, and block until a given
 * child reaches a terminal state.
 */
export class ForEachChildSpawner {
  constructor(private readonly deps: Pick<DispatchDeps, "sessions" | "flows">) {}

  /** Create a child session for one iteration. */
  async spawnChild(
    parentId: string,
    forkGroup: string,
    flowRef: string | InlineFlowSpec,
    inputs: Record<string, unknown>,
    index: number,
    overrides?: SpawnOverrides,
  ): Promise<SpawnChildResult> {
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
   *
   * The deadline is *idle-based*: it extends whenever the child's
   * `updated_at` advances (every event log bumps that timestamp). A child
   * that's actively tool-calling or streaming model output therefore never
   * times out, while a genuinely silent child gives up after `idleMs`.
   */
  async waitForChild(
    childId: string,
    idleMs: number = CHILD_IDLE_TIMEOUT_MS,
  ): Promise<"completed" | "failed" | "timeout"> {
    let lastUpdatedAt: string | undefined;
    let deadline = Date.now() + idleMs;
    while (Date.now() < deadline) {
      const child = await this.deps.sessions.get(childId);
      if (!child) return "failed";
      if (child.status === "completed") return "completed";
      if (child.status === "failed") return "failed";
      // stopped / archived are also terminal -- treat as failure
      if (child.status === "stopped" || child.status === "archived") return "failed";
      if (child.updated_at !== lastUpdatedAt) {
        lastUpdatedAt = child.updated_at;
        deadline = Date.now() + idleMs;
      }
      await Bun.sleep(CHILD_POLL_INTERVAL_MS);
    }
    return "timeout";
  }
}
