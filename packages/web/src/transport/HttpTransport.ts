import type { WebTransport } from "./types.js";

/**
 * Default production transport -- HTTP JSON-RPC + browser EventSource.
 *
 * Token resolution precedence matches the previous behaviour in `App.tsx`:
 *   1. explicit constructor `opts.token`
 *   2. `?token=...` in `window.location.search`
 *   3. `localStorage.getItem("ark-token")` (set by `LoginPage`)
 *
 * `setToken()` updates the bearer + persists to localStorage; the login flow
 * calls it after a successful credential probe so subsequent RPCs see the key.
 */
const TOKEN_STORAGE_KEY = "ark-token";

export class HttpTransport implements WebTransport {
  private base: string;
  private token: string | null;
  private rpcId = 0;

  constructor(opts: { base?: string; token?: string | null } = {}) {
    // Guard window access so this module can be imported in SSR/test contexts
    // where window is undefined. In the browser the defaults kick in.
    const hasWindow = typeof window !== "undefined";
    this.base = opts.base ?? (hasWindow ? window.location.origin : "");
    if (opts.token !== undefined) {
      this.token = opts.token;
    } else if (hasWindow) {
      const urlToken = new URLSearchParams(window.location.search).get("token");
      if (urlToken) {
        this.token = urlToken;
      } else {
        try {
          this.token = window.localStorage?.getItem(TOKEN_STORAGE_KEY) ?? null;
        } catch {
          this.token = null;
        }
      }
    } else {
      this.token = null;
    }
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

  /**
   * Persist + activate a new bearer token. Used by the login flow so
   * subsequent RPCs go out authenticated without a full page reload.
   */
  setToken(token: string | null): void {
    this.token = token;
    if (typeof window === "undefined") return;
    try {
      if (token) window.localStorage?.setItem(TOKEN_STORAGE_KEY, token);
      else window.localStorage?.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      /* localStorage unavailable (private mode / sandbox) -- token stays in-memory only. */
    }
  }
}
