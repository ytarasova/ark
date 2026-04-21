/**
 * Shared RPC helper type for domain-scoped client mixins.
 *
 * The `ArkClient` facade (`../client.ts`) owns the transport and hands
 * each mixin a bound `RpcFn` that performs a JSON-RPC 2.0 request with
 * timeouts and pending-promise bookkeeping. Mixins never see the
 * transport directly -- they just call `rpc<T>("method", params)`.
 */

/** A typed JSON-RPC call shim supplied by the facade to every mixin. */
export type RpcFn = <T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
