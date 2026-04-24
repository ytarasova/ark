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
/**
 * If `expr` is either a plain dotted key or a bare `{{ path }}` template,
 * return the path string. Complex templates (filters, concatenation,
 * multiple vars) return null so the caller falls through to full Nunjucks
 * rendering.
 */
function unwrapBarePath(expr: string): string | null {
  const s = expr.trim();
  if (!s) return null;
  if (!s.includes("{{")) return s;
  if (!s.startsWith("{{") || !s.endsWith("}}")) return null;
  const inner = s.slice(2, -2).trim();
  // A bare path is identifier-chars + dots only -- reject filters (|),
  // operators, whitespace, and nested templates.
  if (!inner || inner.includes(" ") || inner.includes("|") || inner.includes("{{")) return null;
  return inner;
}

export function resolveForEachList(
  expr: string,
  sessionVars: Record<string, unknown>,
  session: Record<string, unknown>,
): unknown[] {
  // Fast path: the expression is a single dotted path (bare template or plain
  // key). Resolve it natively so native types (array of objects, numbers,
  // booleans) survive -- Nunjucks would stringify an array of objects to
  // "[object Object],..." and the coercer would then split it by comma.
  const path = unwrapBarePath(expr);
  if (path !== null) {
    const fromVars = Object.prototype.hasOwnProperty.call(sessionVars, path)
      ? sessionVars[path]
      : resolveDotted(sessionVars, path);
    if (fromVars !== undefined) return coerceToArray(fromVars);
    const fromConfig = resolveDotted((session.config as Record<string, unknown>) ?? {}, path);
    if (fromConfig !== undefined) return coerceToArray(fromConfig);
    throw new Error(`Cannot resolve for_each list: '${expr}' -- no value for '${path}'`);
  }

  // Complex template (filters, concatenation, multiple variables). Render via
  // Nunjucks as a string, then best-effort coerce to an array.
  const rendered = substituteVars(expr, sessionVars);
  if (rendered.startsWith("{{") && rendered.endsWith("}}")) {
    throw new Error(`Cannot resolve for_each list: '${expr}' rendered to unresolvable '${rendered}'`);
  }
  return coerceToArray(rendered);
}
