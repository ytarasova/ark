/**
 * Web UI dashboard -- browser-based session management.
 * Serves a React SPA + single JSON-RPC endpoint + SSE live updates on one port.
 *
 * All API traffic goes through POST /api/rpc, dispatching to the shared RPC
 * router used by CLI and web alike.
 *
 * Non-RPC endpoints:
 *   - GET  /api/health          Lightweight health probe (no auth, no DB)
 *   - GET  /api/events/stream   SSE for live session updates
 *   - WS   /api/terminal?session=<id>  WebSocket terminal bridge (xterm.js)
 *   - POST /api/webhooks/...    GitHub issue webhooks
 *   - GET  /*                   Static file serving (SPA)
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, resolve } from "path";
import type { AppContext } from "../app.js";
import { eventBus } from "../hooks.js";
import { Router } from "../../server/router.js";
import { registerAllHandlers } from "../../server/register.js";
import { DEFAULT_CHANNEL_BASE_URL } from "../constants.js";
import {
  handleIssueWebhook,
  type IssueWebhookConfig,
  type IssueWebhookPayload,
} from "../integrations/github-webhook.js";
import { handleWebhookRequest, matchWebhookPath } from "../../server/handlers/webhooks.js";
import { type SSEBus, createSSEBus } from "./sse-bus.js";
import { extractTenantContext, canWrite, type AuthConfig } from "../auth/index.js";
import type { TenantContext } from "../../types/index.js";
import { resolveWebDist } from "../install-paths.js";
import {
  startTerminalBridge,
  handleTerminalInput,
  cleanupTerminalBridge,
  sanitizeSessionName,
} from "./terminal-bridge.js";
import { VERSION } from "../version.js";
import { createHmac, timingSafeEqual } from "crypto";
import { logInfo, logDebug } from "../observability/structured-log.js";

const WEB_DIST: string = resolveWebDist();
const SERVER_BOOT_TIME = Date.now();

export interface WebServerOptions {
  port?: number;
  readOnly?: boolean;
  token?: string;
  /** API-only mode: skip static file serving (used in dev with Vite) */
  apiOnly?: boolean;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function errorResponse(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ ok: false, message }, status);
}

/** Set of RPC methods that mutate state -- blocked in readOnly mode. */
const WRITE_METHODS = new Set([
  "session/start",
  "session/stop",
  "session/advance",
  "session/complete",
  "session/delete",
  "session/undelete",
  "session/fork",
  "session/clone",
  "session/update",
  "session/handoff",
  "session/spawn",
  "session/resume",
  "session/pause",
  "session/interrupt",
  "session/archive",
  "session/restore",
  "session/import",
  "message/send",
  "gate/approve",
  "todo/add",
  "todo/toggle",
  "todo/delete",
  "verify/run",
  "worktree/finish",
  "worktree/create-pr",
  "worktree/cleanup",
  "skill/save",
  "skill/delete",
  "recipe/delete",
  "agent/create",
  "agent/update",
  "agent/delete",
  "flow/create",
  "flow/delete",
  "compute/create",
  "compute/update",
  "compute/provision",
  "compute/start-instance",
  "compute/stop-instance",
  "compute/destroy",
  "compute/clean",
  "compute/reboot",
  "compute/kill-process",
  "compute/docker-action",
  "costs/record",
  "schedule/create",
  "schedule/delete",
  "schedule/enable",
  "schedule/disable",
  "mcp/attach",
  "mcp/detach",
  "mcp/attach-by-dir",
  "mcp/detach-by-dir",
  "memory/add",
  "memory/forget",
  "memory/clear",
  "knowledge/ingest",
  "knowledge/index",
  "knowledge/import",
  "knowledge/export",
  "learning/add",
  "group/create",
  "group/delete",
  "profile/create",
  "profile/delete",
  "profile/set",
  "config/write",
  "history/import",
  "history/refresh",
  "history/index",
  "history/rebuild-fts",
  "history/refresh-and-index",
  "tools/delete",
]);

export function startWebServer(app: AppContext, opts?: WebServerOptions): { stop: () => void; url: string } {
  const port = opts?.port ?? 8420;
  const readOnly = opts?.readOnly ?? false;
  const apiOnly = opts?.apiOnly ?? false;
  const token = opts?.token;

  // ── Set up in-process RPC router ─────────────────────────────────────────
  const router = new Router();
  registerAllHandlers(router, app);
  router.markInitialized();

  // Kick the background dispatcher on every session_created lifecycle
  // event. The 3s broadcastSessions interval below relays the resulting
  // status transitions to SSE clients, so we don't need to push a
  // per-session notification from here.
  app.sessionService.registerDefaultDispatcher(() => {
    /* status propagated via broadcastSessions polling */
  });

  // Auto-build web frontend if dist doesn't exist (skip in API-only mode)
  if (!apiOnly && !existsSync(WEB_DIST)) {
    try {
      const buildScript = join(import.meta.dir, "../../packages/web/build.ts");
      if (existsSync(buildScript)) {
        execFileSync("bun", ["run", buildScript], { stdio: "pipe", timeout: 30_000 });
      }
    } catch {
      logInfo("web", "build failed - will serve 404s");
    }
  }

  // ── SSE (backed by pluggable SSEBus) ─────────────────────────────────────
  const sseBus: SSEBus = createSSEBus();
  const sseClients = new Set<ReadableStreamDefaultController>();

  function broadcast(event: string, data: any) {
    // Publish through the bus (enables future Redis-backed scaling)
    sseBus.publish("sessions", event, data);
  }

  // Subscribe the direct-to-client broadcaster to the bus
  sseBus.subscribe("sessions", (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.enqueue(new TextEncoder().encode(msg));
      } catch {
        sseClients.delete(client);
      }
    }
  });

  function broadcastSessions() {
    const sessions = app.sessions.list({ limit: 200 });
    broadcast(
      "sessions",
      sessions.map((s) => ({
        id: s.id,
        summary: s.summary,
        status: s.status,
        agent: s.agent,
        repo: s.repo,
        group: s.group_name,
        updated: s.updated_at,
      })),
    );
  }

  const statusInterval = setInterval(broadcastSessions, 3000);

  const unsubEventBus = eventBus.onAll((event) => {
    if (event.type === "hook_status" || event.type.startsWith("session")) {
      broadcastSessions();
    }
  });

  // ── Auth config ──────────────────────────────────────────────────────────
  const authConfig: AuthConfig = app.config.auth ?? { enabled: false, apiKeyEnabled: false };
  let apiKeyMgr: import("./api-keys.js").ApiKeyManager | null = null;
  try {
    apiKeyMgr = app.apiKeys;
  } catch {
    logInfo("web", "not booted yet or unavailable");
  }

  // ── Server ───────────────────────────────────────────────────────────────
  const server = Bun.serve({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      // Health probe -- unauthenticated, used by desktop app and external monitors
      // to verify the web server is up. Lightweight: no DB or service checks.
      if (url.pathname === "/api/health" && req.method === "GET") {
        return jsonResponse({
          ok: true,
          version: VERSION,
          uptime: Math.round((Date.now() - SERVER_BOOT_TIME) / 1000),
        });
      }

      // Token auth (legacy simple token) -- checked first for backward compat.
      // Compared in constant time so the response latency does not leak a
      // per-byte oracle against the shared token.
      if (token) {
        const provided =
          url.searchParams.get("token") ?? req.headers.get("authorization")?.replace("Bearer ", "") ?? "";
        const expected = Buffer.from(token);
        const providedBuf = Buffer.from(provided);
        const lengthOk = providedBuf.length === expected.length;
        // Pad to the expected length so timingSafeEqual never throws; the
        // result is ignored on length mismatch but the compare still runs.
        const cmpBuf = lengthOk ? providedBuf : expected;
        if (!lengthOk || !timingSafeEqual(cmpBuf, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      // Multi-tenant auth -- extract tenant context from request
      let tenantCtx: TenantContext | null = null;
      if (authConfig.enabled) {
        tenantCtx = extractTenantContext(req, authConfig, apiKeyMgr);
        if (!tenantCtx) {
          return jsonResponse({ error: "Unauthorized - valid API key required" }, 401);
        }
      }

      // Determine which app context to use for this request
      const requestApp = tenantCtx && tenantCtx.tenantId !== "default" ? app.forTenant(tenantCtx.tenantId) : app;

      // WebSocket terminal bridge
      if (url.pathname === "/api/terminal") {
        if (readOnly) return new Response("Read-only mode", { status: 403 });
        const sessionId = url.searchParams.get("session");
        if (!sessionId) return new Response("Missing session param", { status: 400 });
        // Sanitize sessionId to prevent command injection in tmux/script commands
        try {
          sanitizeSessionName(sessionId);
        } catch {
          return new Response("Invalid session ID", { status: 400 });
        }
        // Validate session exists
        const session = requestApp.sessions.get(sessionId);
        if (!session) return new Response("Session not found", { status: 404 });
        const tmuxName = `ark-${sessionId}`;
        const upgraded = server.upgrade(req, { data: { sessionId, tmuxName } } as any);
        if (upgraded) return undefined as any;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // SSE endpoint
      if (url.pathname === "/api/events/stream") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
          },
          cancel(controller) {
            sseClients.delete(controller);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            ...CORS,
          },
        });
      }

      // JSON-RPC endpoint
      if (url.pathname === "/api/rpc" && req.method === "POST") {
        try {
          const body = (await req.json()) as {
            jsonrpc?: string;
            method?: string;
            id?: string | number;
            params?: unknown;
          };
          if (!body || body.jsonrpc !== "2.0" || !body.method) {
            return jsonResponse(
              {
                jsonrpc: "2.0",
                id: body?.id ?? null,
                error: { code: -32600, message: "Invalid JSON-RPC request" },
              },
              400,
            );
          }
          // Read-only guard
          if (readOnly && WRITE_METHODS.has(body.method)) {
            return jsonResponse(
              {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32603, message: "Read-only mode" },
              },
              403,
            );
          }
          // Tenant write permission guard
          if (tenantCtx && WRITE_METHODS.has(body.method) && !canWrite(tenantCtx)) {
            return jsonResponse(
              {
                jsonrpc: "2.0",
                id: body.id,
                error: { code: -32603, message: "Insufficient permissions -- viewer role cannot write" },
              },
              403,
            );
          }
          // Create a tenant-scoped router if needed
          let rpcRouter = router;
          if (tenantCtx && tenantCtx.tenantId !== "default") {
            rpcRouter = new Router();
            registerAllHandlers(rpcRouter, requestApp);
            rpcRouter.markInitialized();
          }
          const result = await rpcRouter.dispatch(body);
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err, 400);
        }
      }

      // Unified trigger webhooks: POST /api/webhooks/:source (or /webhooks/:source).
      // Handles every registered source (github, bitbucket, slack, linear, jira,
      // generic-hmac, ...). Signature verification + 2xx-fast dispatch lives in
      // packages/server/handlers/webhooks.ts.
      if (req.method === "POST" && matchWebhookPath(url.pathname)) {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const response = await handleWebhookRequest(requestApp, req, {
            tenant: tenantCtx?.tenantId ?? "default",
          });
          return response;
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GitHub issue webhook (legacy pre-unified path).
      if (url.pathname === "/api/webhooks/github/issues" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const rawBody = await req.text();
          // Verify webhook signature if a secret is configured
          const webhookSecret = process.env.ARK_GITHUB_WEBHOOK_SECRET;
          if (webhookSecret) {
            const signature = req.headers.get("x-hub-signature-256");
            if (!signature) {
              return jsonResponse({ ok: false, message: "Missing webhook signature" }, 401);
            }
            const expected = "sha256=" + createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
            const sigBuf = Buffer.from(signature);
            const expBuf = Buffer.from(expected);
            if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
              return jsonResponse({ ok: false, message: "Invalid webhook signature" }, 401);
            }
          }
          const payload = JSON.parse(rawBody) as IssueWebhookPayload;
          const config: IssueWebhookConfig = {
            triggerLabel: url.searchParams.get("label") ?? "ark",
            autoDispatch: url.searchParams.get("dispatch") === "true",
            flow: url.searchParams.get("flow") ?? undefined,
            group: url.searchParams.get("group") ?? undefined,
          };
          const result = await handleIssueWebhook(requestApp, payload, config);
          return jsonResponse(result, result.ok ? 200 : 400);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // ── Static file serving ────────────────────────────────────────────────
      if (apiOnly) return new Response("Not Found", { status: 404, headers: CORS });

      const staticExts: Record<string, string> = {
        ".js": "application/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      };
      const ext = url.pathname.slice(url.pathname.lastIndexOf("."));
      if (staticExts[ext]) {
        const filePath = resolve(join(WEB_DIST, url.pathname));
        if (!filePath.startsWith(resolve(WEB_DIST))) {
          return new Response("Forbidden", { status: 403, headers: CORS });
        }
        if (existsSync(filePath)) {
          return new Response(Bun.file(filePath), {
            headers: { "Content-Type": staticExts[ext], ...CORS },
          });
        }
      }

      // SPA index.html -- serve for all non-API, non-static routes (catchall for client-side routing)
      if (!staticExts[ext]) {
        const indexPath = join(WEB_DIST, "index.html");
        if (existsSync(indexPath)) {
          let html = readFileSync(indexPath, "utf-8");
          const authAttr = token ? ' data-auth="true"' : "";
          const rootAttrs = `id="root"${readOnly ? ' data-readonly="true"' : ""}${authAttr}`;
          html = html.replace('id="root"', rootAttrs);
          return new Response(html, {
            headers: { "Content-Type": "text/html", ...CORS },
          });
        }
      }

      return new Response("Not Found", { status: 404, headers: CORS });
    },
    websocket: {
      open(ws) {
        const { sessionId, tmuxName } = ws.data as { sessionId: string; tmuxName: string };
        // The launcher uses `$ARK_SESSION_DIR/geometry` as the handshake
        // sentinel. Keep this path in lockstep with the executor wiring
        // (see executors/claude-code.ts + services/agent-launcher.ts).
        const sessionDir = join(app.config.tracksDir, sessionId);
        const bridge = startTerminalBridge(ws, tmuxName, {
          sessionId,
          sessionDir,
          onGeometry: (id, cols, rows) => {
            try {
              app.sessions.update(id, { pty_cols: cols, pty_rows: rows });
            } catch (e: any) {
              logDebug("web", `pty_cols/rows persist failed for ${id}: ${e?.message ?? e}`);
            }
          },
        });
        if (bridge) {
          ws.send(JSON.stringify({ type: "connected", sessionId }));
        } else {
          ws.send(JSON.stringify({ type: "error", message: "tmux session not found" }));
          ws.close();
        }
      },
      message(ws, data) {
        handleTerminalInput(ws, data as any);
      },
      close(ws) {
        cleanupTerminalBridge(ws);
      },
    },
  });

  // Check daemon health on web server start
  (async () => {
    try {
      const resp = await fetch("http://localhost:19100/health", { signal: AbortSignal.timeout(1000) });
      if (resp.ok) console.warn("Conductor: online");
      else console.warn("WARNING: Conductor not responding. Run: ark server daemon start");
    } catch {
      console.warn("WARNING: Conductor not running. Sessions won't advance. Run: ark server daemon start --detach");
    }
  })();

  const serverUrl = `${DEFAULT_CHANNEL_BASE_URL}:${port}${token ? `?token=${token}` : ""}`;

  return {
    url: serverUrl,
    stop: () => {
      clearInterval(statusInterval);
      unsubEventBus();
      sseBus.clear();
      for (const client of sseClients) {
        try {
          client.close();
        } catch {
          logDebug("web", "ignore");
        }
      }
      sseClients.clear();
      server.stop();
    },
  };
}
