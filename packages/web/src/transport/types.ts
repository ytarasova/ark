/**
 * WebTransport -- the single port through which the web UI talks to the server.
 *
 * Per Agent 5's frontend-DI audit: the app needs a thin transport interface
 * injected via React context, not a DI library. Concrete implementations:
 *   - `HttpTransport` for production (real fetch + real EventSource).
 *   - `MockTransport` for unit tests (register per-method handlers).
 *
 * Kept deliberately small: all non-SSE RPC goes through `rpc()`; SSE goes
 * through `createEventSource()`; bearer-token rotation goes through
 * `setToken()` (called by the login page after a successful probe).
 */
export interface WebTransport {
  /** JSON-RPC call against the server's /api/rpc endpoint. */
  rpc<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Resolve an SSE path (e.g. "/api/events/stream") to a full URL including token. */
  sseUrl(path: string): string;
  /** Construct an EventSource for the given SSE path. */
  createEventSource(path: string): EventSource;
  /**
   * Update (or clear) the bearer token used for subsequent RPCs.
   * Implementations may persist the value (production `HttpTransport` writes
   * to localStorage); `MockTransport` just remembers it for assertions.
   */
  setToken(token: string | null): void;
  /**
   * Subscribe to live tree snapshots for a root session via the JSON-RPC
   * WebSocket on the server daemon. Returns the initial tree snapshot and an
   * `unsubscribe` function. `onUpdate` is called with each subsequent root
   * snapshot pushed by the server.
   *
   * Replaces the old SSE-based `/api/sessions/:id/tree/stream` consumer so
   * the session tree stays live over the same JSON-RPC connection used for
   * terminal and log subscriptions.
   */
  sessionTreeStream(
    sessionId: string,
    onUpdate: (root: unknown) => void,
  ): Promise<{ tree: unknown; unsubscribe: () => void }>;
}
