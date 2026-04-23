import type { WebTransport } from "./types.js";

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * In-memory WebTransport for unit tests.
 *
 * Register per-method handlers via `.register()`; the `rpc()` call resolves
 * with the handler's return value (or rejects if the handler throws).
 * Unregistered methods reject with a helpful error so tests fail loudly
 * rather than hang.
 *
 * `createEventSource()` returns a minimal stub object that records open/close
 * without touching the network. For more sophisticated SSE tests, call
 * `.onCreateEventSource()` to install a custom factory.
 */
export class MockTransport implements WebTransport {
  private handlers = new Map<string, Handler>();
  private esFactory: ((path: string) => EventSource) | null = null;

  /** Last token passed to setToken() -- exposed for login-flow assertions. */
  public token: string | null = null;

  /** Record of every rpc() call -- useful for assertions. */
  public readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];

  /** Register a handler for a JSON-RPC method. */
  register(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Install a custom EventSource factory for SSE tests. */
  onCreateEventSource(factory: (path: string) => EventSource): this {
    this.esFactory = factory;
    return this;
  }

  async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`MockTransport: no handler registered for method "${method}"`);
    }
    const result = await handler(params);
    return result as T;
  }

  sseUrl(path: string): string {
    return `mock://${path}`;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  createEventSource(path: string): EventSource {
    if (this.esFactory) return this.esFactory(path);
    // Minimal stub: addEventListener / close / onerror no-ops, valid url/readyState.
    const stub = {
      url: this.sseUrl(path),
      readyState: 1,
      withCredentials: false,
      CONNECTING: 0 as const,
      OPEN: 1 as const,
      CLOSED: 2 as const,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      close: () => {},
      onopen: null,
      onmessage: null,
      onerror: null,
    };
    return stub as unknown as EventSource;
  }
}
