import { Router, type Handler, type NotifyFn } from "./router.js";
import {
  createNotification, isRequest, isNotification, parseMessage,
  type JsonRpcMessage, type JsonRpcNotification,
} from "../protocol/types.js";
import { JsonlCodec, createStdioTransport, type Transport } from "../protocol/transport.js";

export interface ServerConnection {
  id: string;
  transport: Transport;
  subscriptions: string[];
}

export class ArkServer {
  router = new Router();
  private connections = new Map<string, ServerConnection>();
  private connCounter = 0;

  constructor() {
    this.router.requireInitialization();
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
        // Special handling for initialize — extract subscriptions
        if (msg.method === "initialize" && msg.params?.subscribe) {
          conn.subscriptions = msg.params.subscribe as string[];
        }
        const response = await this.router.dispatch(msg, this.notify.bind(this));
        transport.send(response);

        // After initialize response, mark as initialized
        if (msg.method === "initialize" && "result" in response) {
          this.router.markInitialized();
        }
      }
      if (isNotification(msg) && msg.method === "initialized") {
        // Client confirms ready — no-op, just acknowledgment
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

  /** Start server on stdio (JSONL over stdin/stdout). */
  startStdio(): string {
    const transport = createStdioTransport(
      Bun.stdin.stream(),
      { write: (data) => process.stdout.write(data) },
    );
    return this.addConnection(transport);
  }

  /** Start WebSocket server on a port. Returns stop function. */
  startWebSocket(port: number): { stop(): void } {
    const self = this;
    const server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req, server) {
        if (server.upgrade(req)) return;
        return new Response("Ark Server — connect via WebSocket", { status: 200 });
      },
      websocket: {
        open(ws) {
          const connId = `ws-${++self.connCounter}`;
          const handlers: ((msg: JsonRpcMessage) => void)[] = [];

          const conn: ServerConnection = {
            id: connId,
            transport: {
              send(msg) { ws.send(JSON.stringify(msg)); },
              onMessage(handler) { handlers.push(handler); },
              close() { ws.close(); },
            },
            subscriptions: [],
          };

          self.connections.set(connId, conn);
          (ws as any)._arkConnId = connId;
          (ws as any)._arkHandlers = handlers;

          // Wire message routing (same as addConnection)
          conn.transport.onMessage(async (msg) => {
            if (isRequest(msg)) {
              if (msg.method === "initialize" && msg.params?.subscribe) {
                conn.subscriptions = msg.params.subscribe as string[];
              }
              const response = await self.router.dispatch(msg, self.notify.bind(self));
              conn.transport.send(response);
              if (msg.method === "initialize" && "result" in response) {
                self.router.markInitialized();
              }
            }
          });
        },
        message(ws, data) {
          try {
            const msg = parseMessage(typeof data === "string" ? data : new TextDecoder().decode(data as unknown as ArrayBuffer));
            const handlers = (ws as any)._arkHandlers;
            if (handlers) for (const h of handlers) h(msg);
          } catch {}
        },
        close(ws) {
          const connId = (ws as any)._arkConnId;
          if (connId) self.connections.delete(connId);
        },
      },
    });

    return { stop: () => server.stop() };
  }
}

export { Router } from "./router.js";
