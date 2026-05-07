import {
  createResponse,
  createErrorResponse,
  ErrorCodes,
  RpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcError,
} from "../protocol/types.js";
import { validateRequest } from "./validate.js";
import { localAdminContext, type TenantContext } from "../core/auth/context.js";

// ── Role-based method gating ─────────────────────────────────────────────────
//
// Method names follow the convention `<prefix>/<verb>`, e.g. `session/start`,
// `worker/heartbeat`, `admin/apikey/create`. The prefix determines which roles
// are permitted to call the method:
//
//   worker/* -> only callers with role "worker" (or "admin" which is superset)
//   admin/*  -> only callers with role "admin"
//   anything else -> callers with role "user", "member", "viewer", or "admin"
//
// The special-case `initialize` method (no prefix) is allowed for all roles.
// Anonymous / viewer callers are blocked from worker/* and admin/* only --
// they can still hit the user-tier methods (individual handlers can further
// restrict access if needed).

type TenantRole = TenantContext["role"];

/**
 * Return true when `role` is permitted to call `method`.
 *
 * Rules:
 *   - `initialize` (no slash) -> always allowed (handshake method)
 *   - `worker/*` -> allowed for "worker" and "admin"
 *   - `admin/*`  -> allowed for "admin" only
 *   - everything else -> allowed for any role except "worker"
 */
function methodAllowedForRole(method: string, role: TenantRole): boolean {
  // Handshake method has no prefix -- open to all.
  if (method === "initialize") return true;

  if (method.startsWith("worker/")) {
    return role === "worker" || role === "admin";
  }
  if (method.startsWith("admin/")) {
    return role === "admin";
  }
  // User-tier: all roles except dedicated worker tokens.
  return role !== "worker";
}

/** Build a role-gating error message that names the method and required role. */
function forbiddenMessage(method: string): string {
  if (method.startsWith("worker/")) {
    return `${method} requires worker or admin role`;
  }
  if (method.startsWith("admin/")) {
    return `${method} requires admin role`;
  }
  return `${method} is not allowed for this role`;
}

export type NotifyFn = (method: string, params?: Record<string, unknown>) => void;

/**
 * Per-connection subscription registry passed as the optional fourth argument
 * to subscription-style handlers (B7+). Handlers that hold resources open
 * (event bus listeners, timers, etc.) call `subscription.onClose(fn)` to
 * register cleanup. The transport owner (ArkServer WS close handler) calls
 * `subscription.flush()` when the connection drops.
 *
 * Non-subscription handlers may omit the fourth parameter entirely -- JS
 * ignores unused trailing function parameters.
 */
export class Subscription {
  private cleanupFns: Array<() => void> = [];

  /** Register a cleanup function to be called when the connection closes. */
  onClose(fn: () => void): void {
    this.cleanupFns.push(fn);
  }

  /** Call every registered cleanup function and clear the registry. */
  flush(): void {
    for (const fn of this.cleanupFns) {
      try {
        fn();
      } catch {
        /* ignore cleanup errors */
      }
    }
    this.cleanupFns = [];
  }
}

/**
 * Handler signature -- every handler receives:
 *   - `params`: validated JSON-RPC params (via Zod when registered)
 *   - `notify`: per-request notify for push events
 *   - `ctx`: caller's TenantContext (tenant id, user id, isAdmin)
 *   - `subscription`: optional per-connection cleanup registry for
 *     subscription-style handlers that hold resources open after returning
 *
 * `ctx` is always present; in local / single-user mode the router
 * materializes a local-admin context. Hosted mode materializes from the
 * Authorization header / query token via `ApiKeyManager`.
 *
 * Thin handlers that don't use ctx or subscription may still declare them for
 * documentation. Omitting trailing params is safe at runtime too, since JS
 * ignores unused trailing function parameters.
 */
export type Handler = (
  params: Record<string, unknown>,
  notify: NotifyFn,
  ctx: TenantContext,
  subscription?: Subscription,
) => Promise<unknown>;

export class Router {
  private handlers = new Map<string, Handler>();
  private initialized = false;
  private requireInit = false;

  /**
   * Broadcast notify -- set by the transport owner (e.g. ArkServer) so that
   * non-request event flows (lifecycle listeners, schedulers) can push
   * notifications to every subscribed connection without threading a
   * per-request `notify` through. Defaults to a no-op until wired.
   */
  broadcast: NotifyFn = () => {};

  /**
   * Register a handler for `method`. Throws if another handler is already
   * registered for the same name -- the old silent-overwrite behavior
   * hid a real consolidation bug where admin.ts + admin-apikey.ts both
   * registered `admin/apikey/list`, with the latter winning and dropping
   * the former's `include_deleted` parameter.
   *
   * Pass `{ override: true }` when the replacement is intentional (e.g.
   * tests swapping a handler body, or a migration period where two
   * registries both ship the same method).
   */
  handle(method: string, handler: Handler, opts?: { override?: boolean }): void {
    if (this.handlers.has(method) && !opts?.override) {
      throw new Error(
        `Router: duplicate handler registration for '${method}'. ` +
          `Pass { override: true } if the replacement is intentional.`,
      );
    }
    this.handlers.set(method, handler);
  }

  /** Introspection: is a handler registered for this method? */
  hasHandler(method: string): boolean {
    return this.handlers.has(method);
  }

  /** Introspection: list every registered method name. */
  methodNames(): string[] {
    return [...this.handlers.keys()];
  }

  requireInitialization(): void {
    this.requireInit = true;
  }

  markInitialized(): void {
    this.initialized = true;
  }

  async dispatch(
    req: JsonRpcRequest,
    notify?: NotifyFn,
    ctx?: TenantContext,
    subscription?: Subscription,
  ): Promise<JsonRpcResponse | JsonRpcError> {
    if (this.requireInit && !this.initialized && req.method !== "initialize") {
      return createErrorResponse(req.id, ErrorCodes.NOT_INITIALIZED, "Not initialized -- call initialize first");
    }

    const handler = this.handlers.get(req.method);
    if (!handler) {
      return createErrorResponse(req.id, ErrorCodes.METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
    }

    try {
      // Validate request params against the Zod schema registered for this
      // method (if any). Methods without a schema pass through unchanged so
      // handlers using the legacy `extract<T>` helper keep working.
      const params = validateRequest(req.method, req.params);
      const noop: NotifyFn = () => {};
      // Unit tests and single-user callers can dispatch without a ctx;
      // default to a local-admin view in that case. Hosted transports
      // always pass an explicit ctx.
      const effectiveCtx: TenantContext = ctx ?? localAdminContext(null);

      // Role-based method gating: check the caller's role against the method
      // prefix before invoking the handler. Admin has full access; worker tokens
      // are limited to worker/* only; user-tier roles cannot call worker/* or
      // admin/* methods.
      if (!methodAllowedForRole(req.method, effectiveCtx.role)) {
        return createErrorResponse(req.id, ErrorCodes.FORBIDDEN, forbiddenMessage(req.method));
      }

      const result = await handler(params, notify ?? noop, effectiveCtx, subscription);
      return createResponse(req.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RpcError ? err.code : ErrorCodes.INTERNAL_ERROR;
      return createErrorResponse(req.id, code, message);
    }
  }
}
