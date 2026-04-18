import type { WebTransport } from "./types.js";

/**
 * Default production transport -- HTTP JSON-RPC + browser EventSource.
 *
 * The `rpc()` and SSE-URL bodies are lifted verbatim from the previous
 * inline implementations in `useApi.ts` and `useSse.ts` so behaviour
 * remains identical for all 26 existing `api.*` call sites.
 */
export class HttpTransport implements WebTransport {
  private base: string;
  private token: string | null;
  private rpcId = 0;

  constructor(opts: { base?: string; token?: string | null } = {}) {
    this.base = opts.base ?? window.location.origin;
    this.token = opts.token ?? new URLSearchParams(window.location.search).get("token");
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    return headers;
  }

  async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = ++this.rpcId;
    const res = await fetch(`${this.base}/api/rpc`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }),
    });
    const data = await res.json();
    if (data.error) {
      throw new Error(data.error.message || "RPC error");
    }
    return data.result as T;
  }

  sseUrl(path: string): string {
    const sep = path.includes("?") ? "&" : "?";
    return `${this.base}${path}${this.token ? `${sep}token=${this.token}` : ""}`;
  }

  createEventSource(path: string): EventSource {
    return new EventSource(this.sseUrl(path));
  }

  /** Expose the token for callers (e.g. fetchApi) that build non-RPC URLs. */
  getToken(): string | null {
    return this.token;
  }

  /** Expose the base URL. */
  getBase(): string {
    return this.base;
  }
}
