/**
 * Web UI dashboard -- browser-based session management.
 * Serves a React SPA + single JSON-RPC endpoint + SSE live updates on one port.
 *
 * All API traffic goes through POST /api/rpc, dispatching to the shared RPC
 * router used by TUI, CLI, and web alike.
 *
 * Non-RPC endpoints:
 *   - GET  /api/events/stream   SSE for live session updates
 *   - POST /api/webhooks/...    GitHub issue webhooks
 *   - GET  /*                   Static file serving (SPA)
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import type { AppContext } from "../app.js";
import { eventBus } from "../hooks.js";
import { Router } from "../../server/router.js";
import { registerAllHandlers } from "../../server/register.js";
import { DEFAULT_CHANNEL_BASE_URL } from "../constants.js";
import { handleIssueWebhook, type IssueWebhookConfig, type IssueWebhookPayload } from "../integrations/github-webhook.js";
import { type SSEBus, createSSEBus } from "./sse-bus.js";
import { extractTenantContext, canWrite, type AuthConfig } from "../auth/index.js";
import type { TenantContext } from "../../types/index.js";

export interface ResolveWebDistOptions {
  execDir: string;
  sourceDir: string;
  existsCheck: (path: string) => boolean;
}

/**
 * Resolve the directory containing the built web dashboard assets.
 * Installed tarball places the binary at `<root>/bin/ark` with web at `<root>/web`.
 * Running from source, assets live at `packages/web/dist` relative to this file.
 * Returns the installed path as the last-resort default so errors point somewhere real.
 */
export function resolveWebDist(opts: ResolveWebDistOptions): string {
  const installed = join(opts.execDir, "..", "web");
  if (opts.existsCheck(installed)) return installed;
  const source = join(opts.sourceDir, "..", "..", "..", "packages", "web", "dist");
  if (opts.existsCheck(source)) return source;
  return installed;
}

const WEB_DIST: string = resolveWebDist({
  execDir: dirname(process.execPath),
  sourceDir: import.meta.dir,
  existsCheck: existsSync,
});

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
  "session/start", "session/dispatch", "session/stop", "session/advance",
  "session/complete", "session/delete", "session/undelete", "session/fork",
  "session/clone", "session/update", "session/handoff", "session/spawn",
  "session/resume", "session/pause", "session/interrupt", "session/archive",
  "session/restore", "session/import",
  "message/send", "gate/approve",
  "todo/add", "todo/toggle", "todo/delete",
  "verify/run",
  "worktree/finish", "worktree/create-pr", "worktree/cleanup",
  "skill/save", "skill/delete",
  "recipe/delete",
  "agent/create", "agent/update", "agent/delete",
  "flow/create", "flow/delete",
  "compute/create", "compute/delete", "compute/update", "compute/provision",
  "compute/start-instance", "compute/stop-instance", "compute/destroy",
  "compute/clean", "compute/reboot",
  "schedule/create", "schedule/delete", "schedule/enable", "schedule/disable",
  "mcp/attach", "mcp/detach", "mcp/attach-by-dir", "mcp/detach-by-dir",
  "memory/add", "memory/forget", "memory/clear",
  "knowledge/ingest", "knowledge/index", "knowledge/import", "knowledge/export",
  "learning/add",
  "group/create", "group/delete",
  "profile/create", "profile/delete", "profile/set",
  "config/write",
  "history/import", "history/refresh", "history/index",
  "history/rebuild-fts", "history/refresh-and-index",
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

  // Auto-build web frontend if dist doesn't exist (skip in API-only mode)
  if (!apiOnly && !existsSync(WEB_DIST)) {
    try {
      const buildScript = join(import.meta.dir, "../../packages/web/build.ts");
      if (existsSync(buildScript)) {
        execFileSync("bun", ["run", buildScript], { stdio: "pipe", timeout: 30_000 });
      }
    } catch { /* build failed - will serve 404s */ }
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
      try { client.enqueue(new TextEncoder().encode(msg)); }
      catch { sseClients.delete(client); }
    }
  });

  function broadcastSessions() {
    const sessions = app.sessions.list({ limit: 200 });
    broadcast("sessions", sessions.map(s => ({
      id: s.id, summary: s.summary, status: s.status,
      agent: s.agent, repo: s.repo, group: s.group_name,
      updated: s.updated_at,
    })));
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
  try { apiKeyMgr = app.apiKeys; } catch { /* not booted yet or unavailable */ }

  // ── Server ───────────────────────────────────────────────────────────────
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      // Token auth (legacy simple token) -- checked first for backward compat
      if (token) {
        const provided = url.searchParams.get("token") ?? req.headers.get("authorization")?.replace("Bearer ", "");
        if (provided !== token) {
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
      const requestApp = tenantCtx && tenantCtx.tenantId !== "default"
        ? app.forTenant(tenantCtx.tenantId)
        : app;

      // SSE endpoint
      if (url.pathname === "/api/events/stream") {
        const stream = new ReadableStream({
          start(controller) { sseClients.add(controller); },
          cancel(controller) { sseClients.delete(controller); },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...CORS,
          },
        });
      }

      // JSON-RPC endpoint
      if (url.pathname === "/api/rpc" && req.method === "POST") {
        try {
          const body = await req.json() as { jsonrpc?: string; method?: string; id?: string | number; params?: unknown };
          if (!body || body.jsonrpc !== "2.0" || !body.method) {
            return jsonResponse({
              jsonrpc: "2.0", id: body?.id ?? null,
              error: { code: -32600, message: "Invalid JSON-RPC request" },
            }, 400);
          }
          // Read-only guard
          if (readOnly && WRITE_METHODS.has(body.method)) {
            return jsonResponse({
              jsonrpc: "2.0", id: body.id,
              error: { code: -32603, message: "Read-only mode" },
            }, 403);
          }
          // Tenant write permission guard
          if (tenantCtx && WRITE_METHODS.has(body.method) && !canWrite(tenantCtx)) {
            return jsonResponse({
              jsonrpc: "2.0", id: body.id,
              error: { code: -32603, message: "Insufficient permissions -- viewer role cannot write" },
            }, 403);
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

      // GitHub webhook
      if (url.pathname === "/api/webhooks/github/issues" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const payload = await req.json() as IssueWebhookPayload;
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
        const filePath = join(WEB_DIST, url.pathname);
        if (existsSync(filePath)) {
          return new Response(Bun.file(filePath), {
            headers: { "Content-Type": staticExts[ext], ...CORS },
          });
        }
      }

      // SPA index.html
      if (url.pathname === "/" || url.pathname === "/index.html") {
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
  });

  const serverUrl = `${DEFAULT_CHANNEL_BASE_URL}:${port}${token ? `?token=${token}` : ""}`;

  return {
    url: serverUrl,
    stop: () => {
      clearInterval(statusInterval);
      unsubEventBus();
      sseBus.clear();
      for (const client of sseClients) {
        try { client.close(); } catch { /* ignore */ }
      }
      sseClients.clear();
      server.stop();
    },
  };
}
