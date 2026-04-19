/**
 * Scope + builtin-guard helpers shared across resource handlers.
 *
 * The resource CRUD handlers (`agent/*`, `skill/*`, `recipe/*`, ...) all
 * repeat the same pattern:
 *   1. resolve `projectRoot` from `process.cwd()`
 *   2. derive a final `scope` (explicit param wins; otherwise sniff from
 *      `_source` on an existing definition)
 *   3. reject mutations of builtin (packaged) definitions
 *
 * These helpers encode each step once so every new resource gets the same
 * behaviour for free.
 */

import { findProjectRoot } from "../../core/agent/agent.js";

export type Scope = "global" | "project";

export interface SourcedDefinition {
  _source?: "builtin" | "project" | "global" | string;
}

export function resolveProjectRoot(): string | undefined {
  return findProjectRoot(process.cwd()) ?? undefined;
}

/**
 * Final scope for a mutation, in priority order:
 *   1. explicit caller-supplied `requestedScope`
 *   2. scope implied by the existing definition's `_source`
 *   3. `"global"`
 *
 * When the caller asks for `"project"` but `projectRoot` is not resolvable
 * (i.e. the server cwd is not inside a git repo), we honour the request but
 * drop back to `"global"` for the save path -- matches the old behaviour
 * scattered across four handlers.
 */
export function resolveScope(
  requestedScope: Scope | undefined,
  existing: SourcedDefinition | null | undefined,
  projectRoot: string | undefined,
): Scope {
  if (requestedScope === "project") {
    return projectRoot ? "project" : "global";
  }
  if (requestedScope === "global") return "global";
  if (existing?._source === "project") return "project";
  return "global";
}

/**
 * If `existing._source === "builtin"`, throw with a consistent message.
 * Intended for mutating handlers (`update`, `delete`). Pass the resource
 * kind (`"Agent"`, `"Skill"`, ...) and verb (`"edit"`, `"delete"`).
 */
export function guardBuiltin(
  existing: SourcedDefinition | null | undefined,
  kind: string,
  name: string,
  verb: "edit" | "delete",
): void {
  if (!existing) return;
  if (existing._source === "builtin") {
    if (verb === "edit") {
      throw new Error(`${kind} '${name}' is builtin -- copy it to global/project before editing.`);
    }
    throw new Error(`Cannot delete builtin ${kind.toLowerCase()} '${name}'.`);
  }
}

/**
 * The `project` argument to `save()` / `delete()` is only relevant when
 * `scope === "project"`. Compiles the conditional that appears in every
 * caller into a single helper.
 */
export function projectArg(scope: Scope, projectRoot: string | undefined): string | undefined {
  return scope === "project" ? projectRoot : undefined;
}
