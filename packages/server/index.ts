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
      requireToken: app.config.authSection.requireToken,
      defaultTenant: app.config.authSection.defaultTenant,
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
  startWebSocket(port: number): { stop(): void } {
    const self = this;
    const wsMetadata = new WeakMap<
      object,
      {
        connId: string;
        handlers: ((msg: JsonRpcMessage) => void)[];
        authorizationHeader: string | null;
        queryToken: string | null;
      }
    >();
    // Capture upgrade-time credentials via Bun's `data` channel on upgrade().
    type WsData = { authorizationHeader: string | null; queryToken: string | null };
    const server = Bun.serve<WsData, never>({
      port,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url, `http://localhost`);
        const authorizationHeader = req.headers.get("authorization");
        const queryToken = url.searchParams.get("token");
        const data: WsData = { authorizationHeader, queryToken };
        if (server.upgrade(req, { data })) return;
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
        }
        return new Response("Ark Server -- connect via WebSocket", { status: 200 });
      },
      websocket: {
        open(ws) {
          const connId = `ws-${++self.connCounter}`;
          const handlers: ((msg: JsonRpcMessage) => void)[] = [];
          const upgradeData = (ws.data ?? {}) as {
            authorizationHeader?: string | null;
            queryToken?: string | null;
          };
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
        message(ws, data) {
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
          const meta = wsMetadata.get(ws);
          if (meta) self.connections.delete(meta.connId);
        },
      },
    });

    return { stop: () => server.stop() };
  }
}

export { Router } from "./router.js";
