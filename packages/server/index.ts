import { Router, Subscription, type Handler } from "./router.js";
import { createNotification, isRequest, isNotification, parseMessage, type JsonRpcMessage } from "../protocol/types.js";
import { createStdioTransport, type Transport } from "../protocol/transport.js";
import { logDebug } from "../core/observability/structured-log.js";
import {
  localAdminContext,
  materializeContext,
  type TenantContext,
  type MaterializeOptions,
} from "../core/auth/context.js";
import { ArkdClient } from "../arkd/client/index.js";
import { DEFAULT_ARKD_URL } from "../core/constants.js";
import { handleMcpRequest } from "./mcp/index.js";

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
  private app: import("../core/app.js").AppContext | null = null;

  constructor() {
    this.router.requireInitialization();
    this.router.broadcast = this.notify.bind(this);
  }

  /** Capture the AppContext so non-JSON-RPC routes (like /mcp) can use it. */
  attachApp(appCtx: import("../core/app.js").AppContext): void {
    this.app = appCtx;
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
    return this.resolveContextFromCredentials(conn.credentials);
  }

  /**
   * Materialize a TenantContext from raw credential material. Used by
   * non-JSON-RPC entry points (the /terminal/:sessionId WS upgrade path
   * in particular) that need to enforce tenant ownership before upgrading
   * the socket. Handlers on the JSON-RPC path should keep calling
   * `resolveContext(conn)` which delegates through here.
   */
  private async resolveContextFromCredentials(credentials?: {
    authorizationHeader?: string | null;
    queryToken?: string | null;
  }): Promise<TenantContext> {
    if (!this.auth || !this.auth.requireToken) {
      return localAdminContext(this.auth?.defaultTenant ?? null);
    }
    return materializeContext({
      requireToken: true,
      defaultTenant: this.auth.defaultTenant,
      authorizationHeader: credentials?.authorizationHeader ?? null,
      queryToken: credentials?.queryToken ?? null,
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
      /** Tenant id of the resolved session -- downstream bridge runs scoped. */
      tenantId: string;
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
        subscription: Subscription;
      }
    >();
    const terminalMetadata = new WeakMap<
      object,
      {
        sessionId: string;
        tmuxName: string;
        streamHandle: string | null;
        arkdClient: ArkdClient | null;
        streamAbort: AbortController | null;
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

          // Resolve TenantContext from the captured credentials BEFORE any
          // tenant-scoped lookup. Falls through to localAdminContext when
          // auth is disabled (single-tenant local dev); returns a typed
          // rejection when requireToken is on and no valid token was sent.
          let ctx: TenantContext;
          try {
            ctx = await self.resolveContextFromCredentials({ authorizationHeader, queryToken });
          } catch (err: any) {
            return new Response(`Unauthorized: ${err?.message ?? "auth failed"}`, { status: 401 });
          }

          // Tenant-agnostic lookup -- `app.sessions.get(sessionId)` is
          // default-tenant-scoped, so in a hosted deployment it returns null
          // for every cross-tenant session including the caller's own. We
          // need the raw row here to compare `tenant_id` to `ctx.tenantId`.
          // Downstream ops ALWAYS go through the tenant-scoped AppContext.
          const session = await app.sessions.getAcrossTenants(sessionId);
          if (!session) {
            return new Response("Session not found", { status: 404 });
          }
          // Tenant ownership gate: only sessions belonging to the caller's
          // tenant (or admins) can be attached. Cross-tenant pane read +
          // keystroke injection is exactly what round-2 P0-1 closed.
          if (session.tenant_id !== ctx.tenantId && !ctx.isAdmin) {
            return new Response("Forbidden: session belongs to a different tenant", { status: 403 });
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
            tenantId: session.tenant_id,
          };
          if (server.upgrade(req, { data })) return;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        // /mcp -- MCP HTTP endpoint (Streamable HTTP transport).
        if (url.pathname === "/mcp") {
          const mcpApp = self.app ?? app;
          if (!mcpApp) return new Response("MCP route requires AppContext", { status: 503 });
          let ctx: TenantContext;
          try {
            ctx = await self.resolveContextFromCredentials({ authorizationHeader, queryToken });
          } catch (err: any) {
            return new Response(`Unauthorized: ${err?.message ?? "auth failed"}`, { status: 401 });
          }
          // materializeContext returns anonymousContext() for missing/invalid tokens
          // rather than throwing, so the try/catch above doesn't catch unauth in
          // requireToken mode. The terminal route gets away with this because every
          // request carries a session id with its own tenant ownership gate; /mcp
          // has no such per-resource gate -- agent_create and secrets_list would
          // silently scope to "anonymous" and write to a phantom tenant. Explicit
          // 401 here keeps tools from ever seeing an unauth context.
          if (self.auth?.requireToken && ctx.tenantId === "anonymous") {
            return new Response("Unauthorized: missing or invalid bearer token", { status: 401 });
          }
          const tenantApp = ctx.tenantId ? mcpApp.forTenant(ctx.tenantId) : mcpApp;
          return handleMcpRequest(req, tenantApp, ctx);
        }

        // OAuth Protected Resource Metadata (RFC 9728). MCP SDK clients
        // (Claude Code / Desktop / Cursor) probe this endpoint before
        // completing the auth handshake.
        //
        // When auth IS required: return the metadata so the SDK knows the
        // resource accepts bearer tokens. Empty `authorization_servers`
        // declares "no OAuth flow, bearer-only". See #421.
        //
        // When auth is NOT required (local single-tenant mode): return
        // 404. RFC 9728 treats absence of this endpoint as "no OAuth
        // flow needed for this resource" -- which is the truth. Serving
        // an empty-auth-servers metadata in this case caused some SDK
        // clients (Claude Code's MCP client) to fall into an
        // "SDK auth failed" branch with no actionable diagnostic, leaving
        // the user staring at a Capabilities: none dialog while
        // initialize+tools/list both succeed on the wire.
        if (req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          if (!self.auth?.requireToken) {
            return Response.json(
              { error: "no_oauth_flow", message: "This MCP server does not require authentication." },
              { status: 404 },
            );
          }
          const subpath = url.pathname.slice("/.well-known/oauth-protected-resource".length);
          const resourcePath = subpath || "/mcp";
          const origin =
            req.headers.get("x-forwarded-proto") && req.headers.get("x-forwarded-host")
              ? `${req.headers.get("x-forwarded-proto")}://${req.headers.get("x-forwarded-host")}`
              : `http://${req.headers.get("host") ?? "localhost"}`;
          return Response.json({
            resource: `${origin}${resourcePath}`,
            authorization_servers: [],
            bearer_methods_supported: ["header"],
            resource_documentation: "https://github.com/ytarasova/ark/blob/main/docs/mcp.md",
          });
        }

        const data: RpcData = { kind: "rpc", authorizationHeader, queryToken };
        if (server.upgrade(req, { data })) return;
        if (url.pathname === "/health") {
          return Response.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
        }
        // Friendly landing page for /. Other unknown paths get a JSON 404
        // so any future SDK probe that JSON.parses the response doesn't
        // explode on plain text. See #421.
        if (url.pathname === "/" || url.pathname === "") {
          return new Response("Ark Server -- connect via WebSocket", { status: 200 });
        }
        return Response.json({ error: "not found", path: url.pathname }, { status: 404 });
      },
      websocket: {
        async open(ws) {
          const upgradeData = (ws.data ?? {}) as WsData;

          // ── Terminal-attach route ────────────────────────────────────────
          if (upgradeData.kind === "terminal") {
            const { sessionId, tmuxName, tenantId } = upgradeData;
            terminalMetadata.set(ws, {
              sessionId,
              tmuxName,
              streamHandle: null,
              arkdClient: null,
              streamAbort: null,
            });
            try {
              if (!app) throw new Error("terminal route requires AppContext");
              // Bridge runs against the tenant-scoped AppContext so any
              // downstream session/compute reads land in the right tenant.
              // The tenant ownership gate already passed at upgrade time.
              const tenantApp = app.forTenant(tenantId);
              await self.startTerminalBridgeArkd(tenantApp, ws, sessionId, tmuxName, terminalMetadata);
            } catch (err: any) {
              ws.send(JSON.stringify({ type: "error", message: err?.message ?? "attach failed" }));
              try {
                ws.close();
              } catch {
                /* already closed */
              }
            }
            return;
          }

          // ── JSON-RPC route (existing) ────────────────────────────────────
          const connId = `ws-${++self.connCounter}`;
          const handlers: ((msg: JsonRpcMessage) => void)[] = [];
          const authorizationHeader = upgradeData.authorizationHeader ?? null;
          const queryToken = upgradeData.queryToken ?? null;
          // Per-connection subscription registry for subscription-style handlers
          // (e.g. session/tree-stream). Flushed when the WS connection closes.
          const subscription = new Subscription();

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
          wsMetadata.set(ws, { connId, handlers, authorizationHeader, queryToken, subscription });

          // Wire message routing (same as addConnection)
          conn.transport.onMessage(async (msg) => {
            if (isRequest(msg)) {
              if (msg.method === "initialize" && msg.params?.subscribe) {
                conn.subscriptions = msg.params.subscribe as string[];
              }
              const ctx = await self.resolveContext(conn);
              const response = await self.router.dispatch(msg, self.notify.bind(self), ctx, subscription);
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
            if (meta) {
              // Abort the outbound stream first so the read loop exits, then
              // fire-and-forget the remote close call. Swallow errors so
              // browsers reloading the page don't spam the daemon logs.
              try {
                meta.streamAbort?.abort();
              } catch {
                /* ignore */
              }
              if (meta.arkdClient && meta.streamHandle) {
                meta.arkdClient
                  .attachClose({ streamHandle: meta.streamHandle })
                  .catch(() => logDebug("web", "arkd attachClose failed (session likely already gone)"));
              }
            }
            terminalMetadata.delete(ws);
            return;
          }
          const meta = wsMetadata.get(ws);
          if (meta) {
            // Flush subscription cleanups before removing the connection so
            // any open event-bus listeners, timers, etc. are torn down.
            meta.subscription.flush();
            self.connections.delete(meta.connId);
          }
        },
      },
    });

    return { stop: () => server.stop() };
  }

  /**
   * Arkd-backed terminal bridge. Resolves the session's compute, gets the
   * arkd URL via `provider.getArkdUrl(compute)`, opens an attach handle via
   * `/agent/attach/open`, streams pane bytes back via `/agent/attach/stream`
   * (HTTP chunked), and forwards keystrokes / resizes via `/agent/attach/
   * input` and `/agent/attach/resize`. On WS close, `/agent/attach/close`
   * tears the fifo + pipe-pane down.
   *
   * Works uniformly for local, ec2, k8s, firecracker -- any provider with a
   * running arkd. Sessions without an explicit arkd URL fall back to
   * DEFAULT_ARKD_URL (the local daemon on :19300) since that's where the
   * tmux pane lives in single-host mode.
   */
  private async startTerminalBridgeArkd(
    app: import("../core/app.js").AppContext,
    ws: import("bun").ServerWebSocket<unknown>,
    sessionId: string,
    tmuxName: string,
    metadata: WeakMap<
      object,
      {
        sessionId: string;
        tmuxName: string;
        streamHandle: string | null;
        arkdClient: ArkdClient | null;
        streamAbort: AbortController | null;
      }
    >,
  ): Promise<void> {
    // Resolve the session + compute + provider, then the arkd URL.
    const session = await app.sessions.get(sessionId);
    if (!session) throw new Error("session not found");

    const { arkdUrl, token } = await resolveArkdForSession(app, session);
    const arkdClient = new ArkdClient(arkdUrl, token ? { token } : undefined);

    // Open the attach handle. arkd returns the initial capture + a stream
    // handle we then pipe into the WebSocket as binary frames.
    const opened = await arkdClient.attachOpen({ sessionName: tmuxName });
    if (!opened.ok) throw new Error("arkd refused attachOpen");

    const meta = metadata.get(ws);
    if (meta) {
      meta.streamHandle = opened.streamHandle;
      meta.arkdClient = arkdClient;
    }

    // Tell the browser we're live and hand it the initial pane paint.
    ws.send(
      JSON.stringify({
        type: "connected",
        sessionId,
        streamHandle: opened.streamHandle,
        initialBuffer: opened.initialBuffer,
      }),
    );

    // Pipe the chunked byte stream to the WebSocket. AbortController lets
    // the close handler tear this down cleanly.
    const abort = new AbortController();
    if (meta) meta.streamAbort = abort;

    (async () => {
      let streamResp: Response | null = null;
      try {
        streamResp = await fetch(`${arkdUrl}/agent/attach/stream?handle=${encodeURIComponent(opened.streamHandle)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          signal: abort.signal,
        });
        if (!streamResp.ok || !streamResp.body) {
          throw new Error(`arkd stream returned ${streamResp.status}`);
        }
        const reader = streamResp.body.getReader();
        while (!abort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            try {
              ws.sendBinary(value);
            } catch {
              break;
            }
          }
        }
      } catch (err: any) {
        if (!abort.signal.aborted) {
          logDebug("web", `arkd attach stream error: ${err?.message ?? err}`);
        }
      } finally {
        try {
          ws.send(JSON.stringify({ type: "disconnected" }));
        } catch {
          /* already closed */
        }
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    })();
  }

  /**
   * Dispatch an incoming terminal-WS message to the arkd attach endpoints.
   * JSON text messages drive resize; binary / raw text drives input.
   */
  private async handleTerminalMessage(
    ws: import("bun").ServerWebSocket<unknown>,
    data: string | Buffer | ArrayBuffer | Uint8Array,
    metadata: WeakMap<
      object,
      {
        sessionId: string;
        tmuxName: string;
        streamHandle: string | null;
        arkdClient: ArkdClient | null;
        streamAbort: AbortController | null;
      }
    >,
  ): Promise<void> {
    const meta = metadata.get(ws);
    if (!meta || !meta.arkdClient) return;
    const { arkdClient, tmuxName } = meta;

    // JSON envelope handling.
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data);
        if (msg?.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
          const cols = Math.max(1, Math.min(1000, Math.trunc(msg.cols)));
          const rows = Math.max(1, Math.min(1000, Math.trunc(msg.rows)));
          await arkdClient.attachResize({ sessionName: tmuxName, cols, rows }).catch((err) => {
            logDebug("web", `arkd attachResize failed: ${err?.message ?? err}`);
          });
          return;
        }
        if (msg?.type === "input" && typeof msg.data === "string") {
          await arkdClient.attachInput({ sessionName: tmuxName, data: msg.data }).catch((err) => {
            logDebug("web", `arkd attachInput failed: ${err?.message ?? err}`);
          });
          return;
        }
      } catch {
        // Fall through to raw-text input.
      }
      await arkdClient.attachInput({ sessionName: tmuxName, data }).catch((err) => {
        logDebug("web", `arkd attachInput failed: ${err?.message ?? err}`);
      });
      return;
    }

    // Binary input: decode to utf-8 and send via send-keys -l (literal).
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    await arkdClient.attachInput({ sessionName: tmuxName, data: text }).catch((err) => {
      logDebug("web", `arkd attachInput failed: ${err?.message ?? err}`);
    });
  }
}

/**
 * Resolve the arkd URL (+ auth token if the provider supplies one) for a
 * session. For modern providers with `getArkdUrl`, we use the provider's
 * URL. Legacy local sessions fall back to ARK_ARKD_URL / the compiled-in
 * default since the tmux pane lives on the same host as the daemon. Token
 * plumbing: arkd is configured with a shared token at boot (ARK_ARKD_TOKEN);
 * we forward the daemon's own env to remote arkd instances.
 *
 * The env var is re-read on every call (instead of using the imported
 * DEFAULT_ARKD_URL constant) so tests that boot a local arkd on a random
 * port can point the bridge at it without module-cache gymnastics.
 */
async function resolveArkdForSession(
  app: import("../core/app.js").AppContext,
  session: { compute_name?: string | null },
): Promise<{ arkdUrl: string; token: string | null }> {
  const token = process.env.ARK_ARKD_TOKEN ?? null;
  const fallback = process.env.ARK_ARKD_URL || DEFAULT_ARKD_URL;

  if (!session.compute_name) {
    return { arkdUrl: fallback, token };
  }
  const compute = await app.computes.get(session.compute_name);
  if (!compute) return { arkdUrl: fallback, token };
  // Resolve via the new ComputeTarget API. We keep the per-session port
  // hint on the legacy `getArkdUrl(compute, session)` path until the new
  // Compute interface grows a session-aware variant (#423 follow-up); for
  // the conductor->arkd bridge here the compute-level URL is the right
  // thing -- the bridge is per-compute, not per-session.
  const computeImpl = app.getCompute(compute.compute_kind);
  if (computeImpl && computeImpl.attachExistingHandle) {
    const handle = computeImpl.attachExistingHandle({
      name: compute.name,
      status: compute.status,
      config: (compute.config ?? {}) as Record<string, unknown>,
    });
    if (handle) {
      try {
        return { arkdUrl: computeImpl.getArkdUrl(handle), token };
      } catch (err: any) {
        logDebug("web", `compute.getArkdUrl threw: ${err?.message ?? err}; falling back to default`);
      }
    }
  }
  return { arkdUrl: fallback, token };
}

export { Router } from "./router.js";
