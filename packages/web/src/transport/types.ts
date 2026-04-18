/**
 * WebTransport -- the single port through which the web UI talks to the server.
 *
 * Per Agent 5's frontend-DI audit: the app needs a thin transport interface
 * injected via React context, not a DI library. Concrete implementations:
 *   - `HttpTransport` for production (real fetch + real EventSource).
 *   - `MockTransport` for unit tests (register per-method handlers).
 *
 * Kept deliberately small: all non-SSE RPC goes through `rpc()`; SSE goes
 * through `createEventSource()`.
 */
export interface WebTransport {
  /** JSON-RPC call against the server's /api/rpc endpoint. */
  rpc<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Resolve an SSE path (e.g. "/api/events/stream") to a full URL including token. */
  sseUrl(path: string): string;
  /** Construct an EventSource for the given SSE path. */
  createEventSource(path: string): EventSource;
}
