/**
 * TenantContext plumbing for the JSON-RPC layer.
 *
 * Every JSON-RPC handler receives a `TenantContext` as its third argument.
 * The router materializes this context once per request from the caller's
 * Authorization bearer token (or query-string `token=`); handlers use it
 * to gate admin-only routes and scope reads/writes to a single tenant.
 *
 * Two modes:
 *
 *   1. `requireToken = false` (local / single-user profile)
 *      Every request is treated as `{ tenantId: defaultTenant || "default",
 *      userId: null, role: "admin", isAdmin: true }`. Admin routes pass.
 *
 *   2. `requireToken = true` (control-plane profile)
 *      The router looks up the bearer token via `ApiKeyManager.validate`.
 *      If the token is missing or invalid, the request is dispatched with
 *      `anonymousContext()` (tenantId "anonymous", isAdmin false) and any
 *      `requireAdmin` gate throws `FORBIDDEN`.
 *
 * Keep this file dependency-light: it is imported by the server router and
 * by handler modules, so it must not drag in AppContext wiring.
 */

import type { TenantContext as WireTenantContext } from "../../types/index.js";
import { ErrorCodes, RpcError } from "../../protocol/types.js";
import type { ApiKeyManager } from "./api-keys.js";

/**
 * Handler-facing view of the caller. Adds `isAdmin` as a precomputed
 * boolean on top of the wire `TenantContext` so handlers can write
 * `if (!ctx.isAdmin)` without repeating the role check.
 */
export interface TenantContext extends WireTenantContext {
  /** Precomputed: `role === "admin"`. */
  isAdmin: boolean;
}

/** Whether the caller is an admin. */
export function isAdmin(ctx: TenantContext): boolean {
  return ctx.isAdmin;
}

/**
 * Throw FORBIDDEN if `ctx` is not an admin. Use this at the top of every
 * handler that requires admin privileges. In local / single-user mode the
 * default context has `isAdmin: true`, so this is a no-op there.
 */
export function requireAdmin(ctx: TenantContext): void {
  if (!ctx.isAdmin) {
    throw new RpcError("admin role required", ErrorCodes.FORBIDDEN);
  }
}

/**
 * Local / single-user default context. Used when `requireToken` is off
 * and no bearer token is supplied. `defaultTenant` comes from
 * `config.authSection.defaultTenant` (null-safe fallback to `"default"`).
 */
export function localAdminContext(defaultTenant: string | null | undefined): TenantContext {
  return {
    tenantId: defaultTenant ?? "default",
    userId: "local",
    role: "admin",
    isAdmin: true,
  };
}

/**
 * Anonymous context used when `requireToken` is on but the caller did
 * not supply a valid bearer token. Every admin gate fails closed on this
 * context; read-only handlers may choose to serve an empty tenant.
 */
export function anonymousContext(): TenantContext {
  return {
    tenantId: "anonymous",
    userId: null as unknown as string,
    role: "viewer",
    isAdmin: false,
  };
}

/** Promote a wire `TenantContext` (no `isAdmin` field) into the handler view. */
export function fromWire(ctx: WireTenantContext): TenantContext {
  return { ...ctx, isAdmin: ctx.role === "admin" };
}

export interface MaterializeOptions {
  /** `true` in control-plane profile; `false` in local / test. */
  requireToken: boolean;
  /** Default tenant id for local mode (`config.authSection.defaultTenant`). */
  defaultTenant: string | null | undefined;
  /** Raw `Authorization` header value (may be undefined / null). */
  authorizationHeader?: string | null;
  /** Raw `?token=` query param (may be undefined / null). */
  queryToken?: string | null;
  /** Optional direct bearer token (already parsed). Used by stdio callers. */
  bearerToken?: string | null;
  /** ApiKeyManager for token -> wire TenantContext lookups. */
  apiKeys?: ApiKeyManager | null;
}

/**
 * Materialize a TenantContext from inbound credentials.
 *
 * Precedence for token sources (first non-empty wins):
 *   1. `bearerToken` (explicit)
 *   2. `authorizationHeader` value matching `Bearer <token>`
 *   3. `queryToken`
 *
 * In local mode (`requireToken: false`) the function returns a local-admin
 * context regardless of the token, because the transport may still be
 * anonymous. Handlers that actually need the caller identity (secrets,
 * admin) should check `ctx.isAdmin` rather than the token source.
 */
export async function materializeContext(opts: MaterializeOptions): Promise<TenantContext> {
  if (!opts.requireToken) {
    return localAdminContext(opts.defaultTenant);
  }

  const token = resolveToken(opts);
  if (!token || !opts.apiKeys) {
    return anonymousContext();
  }

  const wire = await opts.apiKeys.validate(token);
  if (!wire) {
    return anonymousContext();
  }
  return fromWire(wire);
}

function resolveToken(opts: MaterializeOptions): string | null {
  if (opts.bearerToken && opts.bearerToken.length > 0) return opts.bearerToken;
  const header = opts.authorizationHeader;
  if (header && header.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token.length > 0) return token;
  }
  if (opts.queryToken && opts.queryToken.length > 0) return opts.queryToken;
  return null;
}

export type { WireTenantContext };
