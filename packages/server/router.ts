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
      const result = await handler(params, notify ?? noop, effectiveCtx, subscription);
      return createResponse(req.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RpcError ? err.code : ErrorCodes.INTERNAL_ERROR;
      return createErrorResponse(req.id, code, message);
    }
  }
}
