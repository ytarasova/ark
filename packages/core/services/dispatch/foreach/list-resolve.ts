/**
 * for_each list-resolution helpers.
 *
 * Given a `for_each` expression (plain config key or Nunjucks template) and
 * the session vars/row, resolve the value to a JavaScript array suitable for
 * iteration.
 *
 * Resolution order for `resolveForEachList`:
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

import { substituteVars } from "../../../template.js";

/**
 * Resolve a dotted path from a nested object. Used to read the list value
 * from session state / config when `for_each` references a nested key.
 */
export function resolveDotted(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cursor: unknown = obj;
  for (const part of parts) {
    if (cursor == null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Coerce an arbitrary resolved value into a `unknown[]`:
 *   - already-an-array -> returned as-is
 *   - JSON-array-string ("[...]") -> JSON.parse, else fall through to split
 *   - other string -> split on newlines or commas (trimmed, empty filtered)
 *   - scalar -> wrapped in a single-element array
 */
export function coerceToArray(value: unknown): unknown[] {
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
export function resolveForEachList(
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
