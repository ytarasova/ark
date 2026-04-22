import { Router, type Handler } from "./router.js";
import { createNotification, isRequest, isNotification, parseMessage, type JsonRpcMessage } from "../protocol/types.js";
import { createStdioTransport, type Transport } from "../protocol/transport.js";
import { logDebug } from "../core/observability/structured-log.js";
import {
  localAdminContext,
  materializeContext,
  type TenantContext,
  type MaterializeOptions,
} from "../core/auth/context.js";

export interface ServerConnection {
  id: string;
  transport: Transport;
  subscriptions: string[];
  /**
   * Per-connection credential material captured at transport open time.
   * WebSocket clients may send the Bearer token as `Authorization` on the
   * upgrade request or as a `?token=` query param; stdio callers inherit
   * the host process's identity so we treat them as local-admin.
   */
  credentials?: {
    authorizationHeader?: string | null;
    queryToken?: string | null;
  };
}

/**
 * Auth settings wired onto the server by `attachAuth(app)`. When absent, the
 * server dispatches every request with a local-admin context (the legacy
 * behavior, used by unit tests and the single-user CLI daemon).
 */
export interface ServerAuthConfig {
  requireToken: boolean;
  defaultTenant: string | null;
  apiKeys: MaterializeOptions["apiKeys"];
}

export class ArkServer {
  router = new Router();
  private connections = new Map<string, ServerConnection>();
  private connCounter = 0;
  private auth: ServerAuthConfig | null = null;

  constructor() {
    this.router.requireInitialization();
    this.router.broadcast = this.notify.bind(this);
  }

  /**
   * Bind an AppContext's lifecycle listeners to the transport. Call once
   * after `AppContext.boot()` so `session_created` events kick the
   * background dispatcher and broadcast `session/updated` to every
   * subscribed connection. Unit tests that don't want real agents
   * launched simply skip this wiring.
   */
  attachLifecycle(app: import("../core/app.js").AppContext): () => void {
    return app.sessionService.registerDefaultDispatcher((session) => {
      if (session) this.notify("session/updated", { session });
    });
  }

  /**
   * Wire auth materialization. Call once after `AppContext.boot()` so the
   * router can resolve `TenantContext` from the caller's bearer token on
   * every request. Without this, the server falls back to local-admin.
   */
  attachAuth(app: import("../core/app.js").AppContext): void {
    this.auth = {
      requireToken: app.config.authSection?.requireToken ?? false,
      defaultTenant: app.config.authSection?.defaultTenant ?? null,
      apiKeys: app.apiKeys,
    };
  }

  /** Register a method handler. */
  handle(method: string, handler: Handler): void {
    this.router.handle(method, handler);
  }

  /** Accept a new transport connection. */
  addConnection(transport: Transport): string {
    const id = `conn-${++this.connCounter}`;
    const conn: ServerConnection = { id, transport, subscriptions: [] };
    this.connections.set(id, conn);

    transport.onMessage(async (msg) => {
      if (isRequest(msg)) {
        // Special handling for initialize -- extract subscriptions
        if (msg.method === "initialize" && msg.params?.subscribe) {
          conn.subscriptions = msg.params.subscribe as string[];
        }
        const ctx = await this.resolveContext(conn);
        const response = await this.router.dispatch(msg, this.notify.bind(this), ctx);
        transport.send(response);

        // After initialize response, mark as initialized
        if (msg.method === "initialize" && "result" in response) {
          this.router.markInitialized();
        }
      }
      if (isNotification(msg) && msg.method === "initialized") {
        // Client confirms ready -- no-op, just acknowledgment
      }
    });

    return id;
  }

  /** Remove a connection. */
  removeConnection(id: string): void {
    const conn = this.connections.get(id);
    if (conn) {
      conn.transport.close();
      this.connections.delete(id);
    }
  }

  /** Push a notification to all subscribed connections. */
  notify(method: string, params?: Record<string, unknown>): void {
    const notification = createNotification(method, params);
    for (const conn of this.connections.values()) {
      if (this.matchesSubscription(method, conn.subscriptions)) {
        conn.transport.send(notification);
      }
    }
  }

  /** Check if a notification method matches any subscription pattern. */
  private matchesSubscription(method: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    for (const pattern of patterns) {
      if (pattern === "**") return true;
      if (pattern === method) return true;
      // Glob: "session/*" matches "session/updated" but not "session/events/logged"
      if (pattern.endsWith("/*")) {
        const prefix = pattern.slice(0, -2);
        const rest = method.slice(prefix.length + 1);
        if (method.startsWith(prefix + "/") && !rest.includes("/")) return true;
      }
    }
    return false;
  }

  /**
   * Resolve the TenantContext for a message on `conn`. In unauthenticated
   * mode (no `attachAuth` call, or `requireToken = false`) this returns a
   * local-admin context with the configured default tenant.
   */
  private async resolveContext(conn: ServerConnection): Promise<TenantContext> {
    if (!this.auth || !this.auth.requireToken) {
      return localAdminContext(this.auth?.defaultTenant ?? null);
    }
    return materializeContext({
      requireToken: true,
      defaultTenant: this.auth.defaultTenant,
      authorizationHeader: conn.credentials?.authorizationHeader ?? null,
      queryToken: conn.credentials?.queryToken ?? null,
      apiKeys: this.auth.apiKeys,
    });
  }

  /** Start server on stdio (JSONL over stdin/stdout). */
  startStdio(): string {
    const transport = createStdioTransport(Bun.stdin.stream(), { write: (data) => process.stdout.write(data) });
    return this.addConnection(transport);
  }

  /** Start WebSocket server on a port. Returns stop function. */
  startWebSocket(port: number, opts?: { app?: import("../core/app.js").AppContext }): { stop(): void } {
    const self = this;
    const app = opts?.app ?? null;
    type TerminalData = {
      kind: "terminal";
      sessionId: string;
      tmuxName: string;
      authorizationHeader: string | null;
      queryToken: string | null;
    };
    type RpcData = {
      kind: "rpc";
      authorizationHeader: string | null;
      queryToken: string | null;
    };
    type WsData = RpcData | TerminalData;
    const wsMetadata = new WeakMap<
      object,
      {
        connId: string;
        handlers: ((msg: JsonRpcMessage) => void)[];
        authorizationHeader: string | null;
        queryToken: string | null;
      }
    >();
    const terminalMetadata = new WeakMap<
      object,
      {
        sessionId: string;
        tmuxName: string;
        streamHandle: string | null;
        cleanup?: () => void;
      }
    >();
    const server = Bun.serve<WsData, never>({
      port,
      hostname: "127.0.0.1",
      async fetch(req, server) {
        const url = new URL(req.url, `http://localhost`);
        const authorizationHeader = req.headers.get("authorization");
        const queryToken = url.searchParams.get("token");

        // /terminal/:sessionId -- dedicated terminal-attach WS route.
        const terminalMatch = url.pathname.match(/^\/terminal\/([A-Za-z0-9_-]+)\/?$/);
        if (terminalMatch) {
          const sessionId = terminalMatch[1]!;
          // Validate tenant ownership + attachability before upgrading. Without
          // this, a caller who can reach the WS port can attach to any tmux
          // pane on the host. We fail fast with an HTTP error so the client
          // can surface a useful message rather than a bare close code.
          if (!app) {
            return new Response("Terminal route requires AppContext", { status: 503 });
          }
          const session = await app.sessions.get(sessionId);
          if (!session) {
            return new Response("Session not found", { status: 404 });
          }
          if (!session.session_id) {
            return new Response("Session has no live tmux pane", { status: 409 });
          }
          // `session_id` was pre-validated by the tmux subsystem when the
          // session was launched, but belt-and-braces check here too.
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(session.session_id)) {
            return new Response("Invalid session name", { status: 400 });
          }
          const data: TerminalData = {
            kind: "terminal",
            sessionId,
            tmuxName: session.session_id,
            authorizationHeader,
            queryToken,
          };
          if (server.upgrade(req, { data })) return;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        const data: RpcData = { kind: "rpc", authorizationHeader, queryToken };
        if (server.upgrade(req, { data })) return;
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
        }
        return new Response("Ark Server -- connect via WebSocket", { status: 200 });
      },
      websocket: {
        async open(ws) {
          const upgradeData = (ws.data ?? {}) as WsData;

          // ── Terminal-attach route ────────────────────────────────────────
          if (upgradeData.kind === "terminal") {
            const { sessionId, tmuxName } = upgradeData;
            terminalMetadata.set(ws, { sessionId, tmuxName, streamHandle: null });
            try {
              const bridge = await self.startTerminalBridgeLocal(ws, tmuxName);
              if (!bridge) {
                ws.send(JSON.stringify({ type: "error", message: "tmux session not found" }));
                ws.close();
                return;
              }
              const meta = terminalMetadata.get(ws);
              if (meta) {
                meta.streamHandle = bridge.streamHandle;
                meta.cleanup = bridge.cleanup;
              }
              ws.send(
                JSON.stringify({
                  type: "connected",
                  sessionId,
                  streamHandle: bridge.streamHandle,
                  initialBuffer: bridge.initialBuffer,
                }),
              );
            } catch (err: any) {
              ws.send(JSON.stringify({ type: "error", message: err?.message ?? "attach failed" }));
              ws.close();
            }
            return;
          }

          // ── JSON-RPC route (existing) ────────────────────────────────────
          const connId = `ws-${++self.connCounter}`;
          const handlers: ((msg: JsonRpcMessage) => void)[] = [];
          const authorizationHeader = upgradeData.authorizationHeader ?? null;
          const queryToken = upgradeData.queryToken ?? null;

          const conn: ServerConnection = {
            id: connId,
            transport: {
              send(msg) {
                ws.send(JSON.stringify(msg));
              },
              onMessage(handler) {
                handlers.push(handler);
              },
              close() {
                ws.close();
              },
            },
            subscriptions: [],
            credentials: { authorizationHeader, queryToken },
          };

          self.connections.set(connId, conn);
          wsMetadata.set(ws, { connId, handlers, authorizationHeader, queryToken });

          // Wire message routing (same as addConnection)
          conn.transport.onMessage(async (msg) => {
            if (isRequest(msg)) {
              if (msg.method === "initialize" && msg.params?.subscribe) {
                conn.subscriptions = msg.params.subscribe as string[];
              }
              const ctx = await self.resolveContext(conn);
              const response = await self.router.dispatch(msg, self.notify.bind(self), ctx);
              conn.transport.send(response);
              if (msg.method === "initialize" && "result" in response) {
                self.router.markInitialized();
              }
            }
          });
        },
        async message(ws, data) {
          const upgradeData = (ws.data ?? {}) as WsData;

          if (upgradeData.kind === "terminal") {
            await self.handleTerminalMessage(ws, data, terminalMetadata);
            return;
          }

          try {
            const msg = parseMessage(
              typeof data === "string" ? data : new TextDecoder().decode(data as unknown as ArrayBuffer),
            );
            const meta = wsMetadata.get(ws);
            if (meta) for (const h of meta.handlers) h(msg);
          } catch {
            logDebug("web", "ignore malformed messages");
          }
        },
        close(ws) {
          const upgradeData = (ws.data ?? {}) as WsData;
          if (upgradeData.kind === "terminal") {
            const meta = terminalMetadata.get(ws);
            if (meta?.cleanup) {
              try {
                meta.cleanup();
              } catch {
                /* best effort */
              }
            }
            terminalMetadata.delete(ws);
            return;
          }
          const meta = wsMetadata.get(ws);
          if (meta) self.connections.delete(meta.connId);
        },
      },
    });

    return { stop: () => server.stop() };
  }

  /**
   * Start a terminal bridge for a WebSocket. For the local-MVP this spawns
   * `script tmux attach-session` just like the hosted web bridge does; remote
   * arkd-to-arkd proxying is deferred (see #396 follow-up).
   *
   * Returns the stream handle and initial pane capture on success so the
   * caller can send the `connected` envelope to the client. Returns null when
   * the tmux session is not running.
   */
  private async startTerminalBridgeLocal(
    ws: import("bun").ServerWebSocket<unknown>,
    tmuxName: string,
  ): Promise<{ streamHandle: string; initialBuffer: string; cleanup: () => void } | null> {
    const tmux = await import("../core/infra/tmux.js");
    if (!tmux.sessionExists(tmuxName)) return null;

    // Initial capture so the client can paint without waiting for keystrokes.
    const initialBuffer = await tmux.capturePaneAsync(tmuxName, { lines: 500, ansi: true });

    // Spawn `script tmux attach-session` to allocate a pseudo-terminal and
    // bridge it to the WebSocket. This is the same approach the hosted web
    // bridge uses; we keep it here so the local daemon stays self-contained.
    const { spawn } = await import("bun");
    const tmuxBin = tmux.tmuxBin();
    const cmd =
      process.platform === "darwin"
        ? ["script", "-q", "/dev/null", tmuxBin, "attach-session", "-t", tmuxName]
        : ["script", "-q", "-c", `${tmuxBin} attach-session -t ${tmuxName}`, "/dev/null"];

    const proc = spawn({ cmd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let alive = true;

    (async () => {
      try {
        const reader = proc.stdout.getReader();
        while (alive) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && alive) {
            try {
              ws.sendBinary(value);
            } catch {
              break;
            }
          }
        }
      } catch {
        /* read error */
      } finally {
        alive = false;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    })();

    // Drain stderr so the pipe doesn't block.
    (async () => {
      try {
        const reader = proc.stderr.getReader();
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } catch {
        /* ignore */
      }
    })();

    proc.exited.then(() => {
      alive = false;
      try {
        ws.send(JSON.stringify({ type: "disconnected" }));
        ws.close();
      } catch {
        /* already closed */
      }
    });

    const streamHandle = `ws-attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cleanup = () => {
      alive = false;
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    };

    // Store proc on the ws so input messages can write to stdin.
    (ws as any).__terminalProc = proc;

    return { streamHandle, initialBuffer, cleanup };
  }

  /** Dispatch an incoming terminal message to the underlying PTY process. */
  private async handleTerminalMessage(
    ws: import("bun").ServerWebSocket<unknown>,
    data: string | Buffer | ArrayBuffer | Uint8Array,
    _metadata: WeakMap<object, { sessionId: string; tmuxName: string; streamHandle: string | null }>,
  ): Promise<void> {
    const proc = (ws as any).__terminalProc as import("bun").Subprocess | undefined;
    if (!proc) return;

    // JSON envelope: { type: "resize", cols, rows } or { type: "input", data }
    if (typeof data === "string") {
      let handled = false;
      try {
        const msg = JSON.parse(data);
        if (msg && msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          const tmux = await import("../core/infra/tmux.js");
          const tmuxBin = tmux.tmuxBin();
          const upgradeData = (ws.data ?? {}) as { tmuxName?: string };
          const tmuxName = upgradeData.tmuxName;
          if (tmuxName) {
            const cols = Math.max(1, Math.min(1000, Math.trunc(msg.cols)));
            const rows = Math.max(1, Math.min(1000, Math.trunc(msg.rows)));
            try {
              const { spawn } = await import("bun");
              const resizeProc = spawn({
                cmd: [tmuxBin, "resize-window", "-t", tmuxName, "-x", String(cols), "-y", String(rows)],
                stdout: "pipe",
                stderr: "pipe",
              });
              resizeProc.exited.catch(() => {
                /* best effort */
              });
            } catch {
              /* resize is best-effort */
            }
          }
          handled = true;
        } else if (msg && msg.type === "input" && typeof msg.data === "string") {
          const sink = proc.stdin as unknown as { write(s: string): number; flush(): void };
          sink.write(msg.data);
          sink.flush();
          handled = true;
        }
      } catch {
        /* not JSON */
      }
      if (!handled) {
        // Raw text input fallback.
        const sink = proc.stdin as unknown as { write(s: string): number; flush(): void };
        sink.write(data);
        sink.flush();
      }
      return;
    }

    // Binary input -- raw keystrokes
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
    const sink = proc.stdin as unknown as { write(b: Uint8Array): number; flush(): void };
    sink.write(bytes);
    sink.flush();
  }
}

export { Router } from "./router.js";
