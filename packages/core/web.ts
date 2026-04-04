/**
 * Web UI dashboard — browser-based session management.
 * Serves static React SPA from packages/web/dist/ + JSON API + SSE live updates on a single port.
 *
 * All data is read from the local SQLite store (no external/untrusted input).
 * Build the frontend with: bun run packages/web/build.ts
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { listSessions, getSession, getEvents, getGroups, type Session } from "./store.js";
import { getAllSessionCosts, formatCost } from "./costs.js";
import {
  startSession,
  dispatch,
  stop,
  resume,
  deleteSessionAsync,
  undeleteSessionAsync,
  getOutput,
} from "./session.js";

// Static file serving for the web frontend
const WEB_DIST = join(import.meta.dir, "../../packages/web/dist");

export interface WebServerOptions {
  port?: number;
  readOnly?: boolean;
  token?: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: CORS });
}

function errorResponse(err: unknown, status = 500): Response {
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ ok: false, message }, status);
}

export function startWebServer(opts?: WebServerOptions): { stop: () => void; url: string } {
  const port = opts?.port ?? 8420;
  const readOnly = opts?.readOnly ?? false;
  const token = opts?.token;

  // SSE clients
  const sseClients = new Set<ReadableStreamDefaultController>();

  // Broadcast to all SSE clients
  function broadcast(event: string, data: any) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.enqueue(new TextEncoder().encode(msg)); }
      catch { sseClients.delete(client); }
    }
  }

  // Periodic broadcast of session status
  const statusInterval = setInterval(() => {
    const sessions = listSessions({ limit: 200 });
    broadcast("sessions", sessions.map(s => ({
      id: s.id, summary: s.summary, status: s.status,
      agent: s.agent, repo: s.repo, group: s.group_name,
      updated: s.updated_at,
    })));
  }, 3000);

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      // Token auth
      if (token) {
        const provided = url.searchParams.get("token") ?? req.headers.get("authorization")?.replace("Bearer ", "");
        if (provided !== token) {
          return new Response("Unauthorized", { status: 401 });
        }
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
            "Connection": "keep-alive",
            ...CORS,
          },
        });
      }

      // --- API routes ---

      // GET /api/openapi.json
      if (url.pathname === "/api/openapi.json") {
        const { generateOpenApiSpec } = await import("./openapi.js");
        return jsonResponse(generateOpenApiSpec());
      }

      // GET /api/status
      if (url.pathname === "/api/status" && req.method === "GET") {
        const sessions = listSessions({ limit: 500 });
        const byStatus: Record<string, number> = {};
        for (const s of sessions) {
          byStatus[s.status] = (byStatus[s.status] || 0) + 1;
        }
        return jsonResponse({ total: sessions.length, byStatus });
      }

      // GET /api/groups
      if (url.pathname === "/api/groups" && req.method === "GET") {
        return jsonResponse(getGroups());
      }

      // GET /api/costs
      if (url.pathname === "/api/costs") {
        const sessions = listSessions({ limit: 500 });
        const costs = getAllSessionCosts(sessions);
        return jsonResponse(costs);
      }

      // POST /api/sessions (create)
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          const session = startSession({
            summary: body.summary,
            repo: body.repo,
            flow: body.flow,
            group_name: body.group_name,
            workdir: body.workdir,
          });
          return jsonResponse({ ok: true, session });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/sessions
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const sessions = listSessions({ limit: 200 });
        return jsonResponse(sessions);
      }

      // Session-specific routes: /api/sessions/:id/...
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(.+)$/);
      if (sessionMatch) {
        const [, id, action] = sessionMatch;

        if (action === "output" && req.method === "GET") {
          try {
            const output = await getOutput(id);
            return jsonResponse({ ok: true, output });
          } catch (err) {
            return errorResponse(err);
          }
        }

        if (req.method === "POST") {
          if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);

          try {
            switch (action) {
              case "dispatch": {
                const result = await dispatch(id);
                return jsonResponse(result);
              }
              case "stop": {
                const result = await stop(id);
                return jsonResponse(result);
              }
              case "restart": {
                const result = await resume(id);
                return jsonResponse(result);
              }
              case "delete": {
                const result = await deleteSessionAsync(id);
                return jsonResponse(result);
              }
              case "undelete": {
                const result = await undeleteSessionAsync(id);
                return jsonResponse(result);
              }
              default:
                return jsonResponse({ error: "Unknown action" }, 404);
            }
          } catch (err) {
            return errorResponse(err);
          }
        }
      }

      // GET /api/sessions/:id (detail)
      if (url.pathname.startsWith("/api/sessions/")) {
        const id = url.pathname.split("/")[3];
        const session = getSession(id);
        if (!session) return jsonResponse({ error: "Not found" }, 404);
        const events = getEvents(id);
        return jsonResponse({ session, events });
      }

      // Static file serving for web frontend
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

      // Dashboard HTML — serve index.html only for root path
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const indexPath = join(WEB_DIST, "index.html");
        if (existsSync(indexPath)) {
          let html = readFileSync(indexPath, "utf-8");
          // Inject read-only and token info as data attributes on root div
          const rootAttrs = `id="root"${readOnly ? ' data-readonly="true"' : ""}`;
          html = html.replace('id="root"', rootAttrs);
          return new Response(html, {
            headers: { "Content-Type": "text/html", ...CORS },
          });
        }
      }

      return new Response("Not Found", { status: 404, headers: CORS });
    },
  });

  const serverUrl = `http://localhost:${port}${token ? `?token=${token}` : ""}`;

  return {
    url: serverUrl,
    stop: () => {
      clearInterval(statusInterval);
      for (const client of sseClients) {
        try { client.close(); } catch { /* ignore */ }
      }
      sseClients.clear();
      server.stop();
    },
  };
}

