/**
 * Helpers for rendering sessions that were dispatched with inline flows /
 * inline agents.
 *
 * The wire surface uses two tells to identify an inline dispatch:
 *   - `session.agent === "inline"` (header's agent prop)
 *   - `session.flow` matches `^inline-s-` (synthetic flow name created by
 *     create.ts when the caller passed an inline flow object)
 *
 * The actual inline agent + flow definitions live on
 * `session.config.inline_flow.{name,stages[i].agent}`. We pull the stage that
 * matches the session's current `stage` and surface its `(runtime, model)`
 * pair so the header can show something meaningful instead of the literal
 * string `inline`.
 */

export interface InlineModelLike {
  id: string;
  display?: string;
  aliases?: string[];
}

export interface InlineDisplayResult {
  /** True when the session's agent column is the literal `"inline"`. */
  isInlineAgent: boolean;
  /** True when the session's flow name matches `^inline-s-`. */
  isInlineFlow: boolean;
  /** Render-ready agent label (e.g. `agent-sdk · Claude Sonnet 4.6`). Null when not inline. */
  agentLabel: string | null;
  /** Inline flow's user-supplied name, or "inline" if it was anonymous. */
  inlineFlowName: string | null;
  /** Stage count of the inline flow definition, for the tooltip. */
  inlineFlowStageCount: number;
}

/**
 * Resolve a model id (or alias) to its display name from a catalog list.
 * Falls back to the raw id when there's no catalog entry.
 */
export function resolveModelDisplay(modelId: string | null | undefined, models: InlineModelLike[] | undefined): string {
  if (!modelId) return "";
  if (!models || models.length === 0) return modelId;
  const direct = models.find((m) => m.id === modelId);
  if (direct?.display) return direct.display;
  const aliased = models.find((m) => Array.isArray(m.aliases) && m.aliases.includes(modelId));
  if (aliased?.display) return aliased.display;
  return modelId;
}

/**
 * Pull the inline agent's `(runtime, model)` from the inline-flow stage that
 * matches the session's current stage. Falls back to the first stage when
 * `session.stage` doesn't line up with any defined stage (e.g. fresh
 * dispatch before stage_ready).
 */
export function resolveInlineDisplay(session: any, models: InlineModelLike[] | undefined): InlineDisplayResult {
  const isInlineAgent = session?.agent === "inline";
  const flowName: string = session?.flow ?? "";
  const isInlineFlow = typeof flowName === "string" && flowName.startsWith("inline-s-");

  const def = session?.config?.inline_flow;
  const stages: any[] = Array.isArray(def?.stages) ? def.stages : [];
  const stageCount = stages.length;

  let agentLabel: string | null = null;
  if (isInlineAgent && stages.length > 0) {
    const current = session?.stage;
    const stage = (current && stages.find((s) => s?.name === current)) || stages[0];
    const inlineAgent = stage?.agent;
    if (inlineAgent && typeof inlineAgent === "object") {
      const runtimeRaw = inlineAgent.runtime;
      const runtimeName =
        typeof runtimeRaw === "string"
          ? runtimeRaw
          : runtimeRaw && typeof runtimeRaw === "object"
            ? (runtimeRaw.name ?? "")
            : "";
      const modelRaw = inlineAgent.model;
      const modelId =
        typeof modelRaw === "string"
          ? modelRaw
          : modelRaw && typeof modelRaw === "object"
            ? (modelRaw.id ?? modelRaw.name ?? "")
            : "";
      const modelDisplay = resolveModelDisplay(modelId, models);
      agentLabel = [runtimeName, modelDisplay].filter(Boolean).join(" · ") || null;
    }
  }

  // Strip the synthetic prefix from the inline flow name when surfacing in
  // the tooltip ("inline-foo" stays "inline-foo"; an unnamed flow is just
  // "inline").
  const rawName = typeof def?.name === "string" ? def.name : null;
  const inlineFlowName =
    rawName && rawName.startsWith("inline-s-") ? "inline" : (rawName ?? (isInlineFlow ? "inline" : null));

  return {
    isInlineAgent,
    isInlineFlow,
    agentLabel,
    inlineFlowName,
    inlineFlowStageCount: stageCount,
  };
}
