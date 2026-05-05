/**
 * for_each iteration variable helpers.
 *
 * Pure functions that build per-iteration template-variable maps and apply
 * Nunjucks substitution to spawn inputs + inline sub-stage definitions. No
 * state and no I/O -- every behaviour is a straight transformation of its
 * inputs.
 */

import type { StageDefinition } from "../../flow.js";
import { substituteVars } from "../../../template.js";

/**
 * Flatten an arbitrary value into a flat dotted-key map so that
 * substituteVars can resolve `{{iterVar.foo}}` templates.
 *
 * - Primitive values (string, number, boolean) are converted to strings.
 * - Objects are flattened recursively with dot-separated paths.
 * - Arrays are stringified at their leaf position.
 *
 * The output value map is `Record<string, unknown>` so native types (arrays
 * of objects, numbers, booleans) can flow through to `resolveForEachList`
 * without being coerced to strings prematurely.
 */
export function flattenItem(prefix: string, value: unknown, out: Record<string, unknown>): void {
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
export function buildIterationVars(
  baseVars: Record<string, unknown>,
  iterVar: string,
  item: unknown,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  flattenItem(iterVar, item, extra);
  // Expose the raw item as the iterVar key (serialised) ONLY when item is a
  // primitive -- so templates like `{{item}}` work for string/number lists.
  // For object items, flattenItem already produced nested flat keys
  // (e.g. `repo.repo_path`); adding a literal `extra.repo = "[object Object]"`
  // would cause `unflatten` (in template.ts) to overwrite the nested form
  // with a string, so `{{repo.repo_path}}` would resolve to undefined and
  // the template would render verbatim.
  if (!(iterVar in extra) && (item === null || typeof item !== "object")) {
    extra[iterVar] = String(item);
  }
  return { ...baseVars, ...extra };
}

/**
 * Substitute Nunjucks templates in every string-valued leaf of an inputs map.
 * Nested objects and arrays are walked recursively; non-string leaves are
 * kept as-is.
 */
export function substituteInputs(
  inputs: Record<string, unknown>,
  vars: Record<string, unknown>,
): Record<string, unknown> {
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
 * Substitute Nunjucks templates in the string fields of a StageDefinition.
 * Used by mode:inline to resolve per-iteration templates before dispatching
 * each sub-stage (task, agent.system_prompt, agent.name, etc.).
 *
 * Only the fields that influence dispatch are substituted:
 *   - task
 *   - agent (if InlineAgentSpec): system_prompt, name, description
 * Other fields (gate, name, on_failure) are passed through unchanged.
 */
export function substituteStageTemplates(stage: StageDefinition, vars: Record<string, unknown>): StageDefinition {
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
