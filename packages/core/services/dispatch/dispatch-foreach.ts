/**
 * for_each + mode:spawn dispatcher (P2.0a).
 *
 * Iterates a list resolved from session inputs/state and spawns one child
 * session per item -- sequentially. Each child is awaited before the next
 * one starts. The legacy `type: fan_out` stage type was removed in P2.0b.
 *
 * Design constraints:
 *   - Sequential only (no parallel knob in P2.0a).
 *   - Iteration variable substitution via Nunjucks / substituteVars.
 *   - on_iteration_failure: stop (default) | continue.
 *   - Reuses DispatchDeps.sessions / events / flows / dispatchChild.
 */

import { randomUUID } from "crypto";

import type { DispatchDeps, DispatchResult } from "./types.js";
import type { StageDefinition } from "../../state/flow.js";
import { substituteVars } from "../../template.js";
import { logDebug, logWarn } from "../../observability/structured-log.js";

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

// ── ForEachDispatcher ────────────────────────────────────────────────────────

/** Milliseconds between polls when waiting for a child session to finish. */
const CHILD_POLL_INTERVAL_MS = 250;
/** Maximum time to wait for a single child session to reach terminal state. */
const CHILD_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class ForEachDispatcher {
  constructor(private readonly deps: Pick<DispatchDeps, "sessions" | "events" | "flows" | "dispatchChild">) {}

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
  async dispatchForEach(
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

    await this.deps.events.log(sessionId, "for_each_start", {
      stage: session.stage,
      actor: "system",
      data: { total: items.length, flow: spawnSpec.flow, iterVar },
    });

    const forkGroup = randomUUID().slice(0, 8);
    let succeeded = 0;
    let failedCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const iterVars = buildIterationVars(sessionVars, iterVar, item);
      const resolvedInputs = substituteInputs(spawnSpec.inputs, iterVars);

      // Spawn a child session for this iteration
      const spawnResult = await this.spawnChild(sessionId, forkGroup, spawnSpec.flow, resolvedInputs, i);
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

      await this.deps.events.log(sessionId, "for_each_iteration_start", {
        stage: session.stage,
        actor: "system",
        data: { index: i, childId, flow: spawnSpec.flow, inputs: resolvedInputs },
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

  /** Create a child session for one iteration. */
  private async spawnChild(
    parentId: string,
    forkGroup: string,
    flowName: string,
    inputs: Record<string, unknown>,
    index: number,
  ): Promise<{ ok: true; childId: string } | { ok: false; message: string }> {
    const parent = await this.deps.sessions.get(parentId);
    if (!parent) return { ok: false, message: "Parent session not found" };

    // Determine the first stage of the target flow
    const flowDef = this.deps.flows.get(flowName);
    if (!flowDef) return { ok: false, message: `Flow '${flowName}' not found` };
    const firstStage = flowDef.stages[0]?.name ?? null;

    const summary = (inputs.summary as string | undefined) ?? `${flowName} iteration ${index}`;
    const child = await this.deps.sessions.create({
      summary,
      repo: parent.repo || undefined,
      flow: flowName,
      compute_name: parent.compute_name || undefined,
      workdir: parent.workdir || undefined,
      group_name: parent.group_name || undefined,
      config: { inputs, for_each_parent: parentId, for_each_index: index },
    });

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
