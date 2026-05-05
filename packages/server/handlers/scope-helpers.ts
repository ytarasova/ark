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
import type { AppContext } from "../../core/app.js";
import type { TenantContext } from "../../core/auth/context.js";
import { RpcError, ErrorCodes } from "../../protocol/types.js";

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
      throw new RpcError(
        `${kind} '${name}' is builtin -- copy it to global/project before editing.`,
        ErrorCodes.FORBIDDEN,
      );
    }
    throw new RpcError(`Cannot delete builtin ${kind.toLowerCase()} '${name}'.`, ErrorCodes.FORBIDDEN);
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

/**
 * Resolve the tenant id for a request. Precedence:
 *   1. the caller's materialized `TenantContext` (router auth middleware)
 *   2. the root AppContext's tenantId (already-scoped view)
 *   3. `config.authSection.defaultTenant` (local single-user mode)
 *   4. the literal `"default"` sentinel
 *
 * Use this for handlers that need a tenant string to pass into a
 * capability (e.g. `app.secrets.list(tenantId)`) but don't need a
 * tenant-scoped AppContext view. For the latter, use `resolveTenantApp`.
 *
 * Previously duplicated across 7 handler files (costs, conductor,
 * workspace, sage, secrets, code-intel, knowledge-rpc).
 */
export function resolveTenantId(app: AppContext, ctx: TenantContext): string {
  return ctx.tenantId ?? app.tenantId ?? app.config.authSection.defaultTenant ?? "default";
}

/**
 * Resolve the tenant-scoped AppContext view for a request. Returns
 * `app.forTenant(id)` when an id is resolvable from the caller's
 * TenantContext (or the root app's already-scoped tenantId, or the
 * configured default tenant); otherwise the root `app` unchanged (the
 * latter is the local single-user fallback).
 *
 * Use this as the canonical way to route RPC handler writes/reads through
 * the tenant-scoped DI child scope. Previously inlined in
 * costs/conductor/sage handlers with identical logic -- see round-3
 * DI P1-1: local-daemon WS path needs tenant-scoped dispatch just like
 * the hosted HTTP path already does (per-request router rebuild).
 */
export function resolveTenantApp(app: AppContext, ctx: TenantContext): AppContext {
  const tenantId = ctx.tenantId ?? app.tenantId ?? app.config.authSection.defaultTenant ?? null;
  return tenantId ? app.forTenant(tenantId) : app;
}
