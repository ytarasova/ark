import type { WebTransport } from "./types.js";

/**
 * Default production transport -- HTTP JSON-RPC + browser EventSource +
 * WebSocket JSON-RPC subscriptions.
 *
 * Token resolution precedence matches the previous behaviour in `App.tsx`:
 *   1. explicit constructor `opts.token`
 *   2. `?token=...` in `window.location.search`
 *   3. `localStorage.getItem("ark-token")` (set by `LoginPage`)
 *
 * `setToken()` updates the bearer + persists to localStorage; the login flow
 * calls it after a successful credential probe so subsequent RPCs see the key.
 *
 * `sessionTreeStream()` opens a dedicated WebSocket to the server daemon's
 * JSON-RPC WebSocket endpoint (default port 19400) and uses the
 * `session/tree-stream` + `session/tree-update` notification pair, mirroring
 * the protocol used by `ArkClient.sessionTreeStream` in the CLI / protocol
 * package.
 */
const TOKEN_STORAGE_KEY = "ark-token";

/** Default port for the server daemon WebSocket (JSON-RPC + subscriptions). */
const DAEMON_WS_PORT = 19400;

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

  /**
   * Subscribe to live session tree snapshots via the server daemon's
   * JSON-RPC WebSocket (port 19400).
   *
   * Opens a dedicated WebSocket, sends `session/tree-stream`, receives the
   * initial snapshot, and listens for `session/tree-update` notifications for
   * subsequent updates. The WebSocket is closed when `unsubscribe()` is called.
   */
  sessionTreeStream(
    sessionId: string,
    onUpdate: (root: unknown) => void,
  ): Promise<{ tree: unknown; unsubscribe: () => void }> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined") {
        reject(new Error("sessionTreeStream requires a browser environment"));
        return;
      }

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.hostname;
      const tokenParam = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
      const url = `${proto}//${host}:${DAEMON_WS_PORT}${tokenParam}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      let rpcId = 1;
      let settled = false;
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      };

      const unsubscribe = () => close();

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpcId++,
            method: "session/tree-stream",
            params: { sessionId },
          }),
        );
      };

      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        // JSON-RPC response to the `session/tree-stream` call -- carries the initial snapshot.
        if (!settled && msg.result !== undefined && msg.id === 1) {
          settled = true;
          resolve({ tree: msg.result?.tree ?? null, unsubscribe });
          return;
        }

        // JSON-RPC error response to the `session/tree-stream` call.
        if (!settled && msg.error !== undefined && msg.id === 1) {
          settled = true;
          close();
          reject(new Error(msg.error?.message ?? "session/tree-stream failed"));
          return;
        }

        // Server-push notification: `session/tree-update`.
        if (msg.method === "session/tree-update" && msg.params?.sessionId === sessionId) {
          onUpdate(msg.params.root);
        }
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          close();
          reject(new Error("WebSocket error connecting to server daemon"));
        }
      };

      ws.onclose = (event) => {
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before session/tree-stream response (code ${event.code})`));
        }
        closed = true;
      };
    });
  }
}
