/**
 * Web UI dashboard -- browser-based session management.
 * Serves static React SPA from packages/web/dist/ + JSON API + SSE live updates on a single port.
 *
 * REST routes delegate to the same RPC handlers used by the TUI and CLI,
 * eliminating duplication. Routes without an RPC equivalent call core directly.
 *
 * Architecture:
 *   Browser -> REST (web.ts) -> Router.dispatch() -> RPC handlers -> core
 *   TUI     -> in-process ArkClient -> ArkServer -> RPC handlers -> core
 *   CLI     -> ArkClient (JSON-RPC)  -> ArkServer -> RPC handlers -> core
 *
 * Build the frontend with: bun run packages/web/build.ts
 */

import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { getApp } from "./app.js";
import { eventBus } from "./hooks.js";
import { Router } from "../server/router.js";
import { registerAllHandlers } from "../server/register.js";
import { handleIssueWebhook, type IssueWebhookConfig, type IssueWebhookPayload } from "./github-webhook.js";
import { exportSession, type SessionExport } from "./session-share.js";
import { searchSessions, searchTranscripts } from "./search.js";
import { searchAllConversations } from "./global-search.js";
import { getLearnings, recordLearning } from "./learnings.js";
import { ingestFile, ingestDirectory } from "./knowledge.js";
import { generateRepoMap } from "./repo-map.js";
import { getHotkeys } from "./hotkeys.js";
import { getThemeMode } from "./theme.js";
import { getAllSessionCosts } from "./costs.js";
import { getActiveProfile } from "./profiles.js";
import { cleanupWorktrees } from "./services/session-orchestration.js";

// Static file serving for the web frontend
const WEB_DIST = join(import.meta.dir, "../../packages/web/dist");

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

// ── RPC bridge ─────────────────────────────────────────────────────────────────

/**
 * Call an RPC handler directly via the Router, bypassing transport/serialization.
 * Throws on RPC errors so callers can use try/catch as before.
 */
async function callRpc(
  router: Router,
  method: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  const fakeReq = { jsonrpc: "2.0" as const, id: 0, method, params };
  const resp = await router.dispatch(fakeReq);
  if ("error" in resp) {
    throw new Error((resp as any).error.message);
  }
  return (resp as any).result;
}

export function startWebServer(opts?: WebServerOptions): { stop: () => void; url: string } {
  const port = opts?.port ?? 8420;
  const readOnly = opts?.readOnly ?? false;
  const apiOnly = opts?.apiOnly ?? false;
  const token = opts?.token;

  // ── Set up in-process RPC router ─────────────────────────────────────────
  const router = new Router();
  registerAllHandlers(router, getApp());
  router.markInitialized(); // bypass initialize handshake for in-process use

  // Auto-build web frontend if dist doesn't exist (skip in API-only mode)
  if (!apiOnly && !existsSync(WEB_DIST)) {
    try {
      const buildScript = join(import.meta.dir, "../../packages/web/build.ts");
      if (existsSync(buildScript)) {
        execFileSync("bun", ["run", buildScript], { stdio: "pipe", timeout: 30_000 });
      }
    } catch { /* build failed - will serve 404s */ }
  }

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

  // Broadcast current session state to all SSE clients
  function broadcastSessions() {
    const sessions = getApp().sessions.list({ limit: 200 });
    broadcast("sessions", sessions.map(s => ({
      id: s.id, summary: s.summary, status: s.status,
      agent: s.agent, repo: s.repo, group: s.group_name,
      updated: s.updated_at,
    })));
  }

  // Periodic broadcast of session status
  const statusInterval = setInterval(broadcastSessions, 3000);

  // Event-driven SSE push (in addition to periodic broadcast)
  const unsubEventBus = eventBus.onAll((event) => {
    // Push on any hook_status or session-related event
    if (event.type === "hook_status" || event.type.startsWith("session")) {
      broadcastSessions();
    }
  });

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

      // ── API routes ─────────────────────────────────────────────────────────

      // GET /api/openapi.json
      if (url.pathname === "/api/openapi.json") {
        const { generateOpenApiSpec } = await import("./openapi.js");
        return jsonResponse(generateOpenApiSpec());
      }

      // GET /api/status
      if (url.pathname === "/api/status" && req.method === "GET") {
        const sessions = getApp().sessions.list({ limit: 500 });
        const byStatus: Record<string, number> = {};
        for (const s of sessions) {
          byStatus[s.status] = (byStatus[s.status] || 0) + 1;
        }
        return jsonResponse({ total: sessions.length, byStatus });
      }

      // GET /api/groups
      if (url.pathname === "/api/groups" && req.method === "GET") {
        try {
          const result = await callRpc(router, "group/list");
          return jsonResponse(result.groups.map((g: any) => g.name));
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/costs/export
      if (url.pathname === "/api/costs/export" && req.method === "GET") {
        const format = url.searchParams.get("format") ?? "json";
        const sessions = getApp().sessions.list({ limit: 500 });
        if (format === "csv") {
          const { exportCostsCsv } = await import("./costs.js");
          const csv = exportCostsCsv(sessions);
          return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=ark-costs.csv", ...CORS } });
        }
        const costs = getAllSessionCosts(sessions);
        return jsonResponse(costs);
      }

      // GET /api/costs
      if (url.pathname === "/api/costs") {
        try {
          const result = await callRpc(router, "costs/read");
          // RPC returns { costs, total }, REST API returns { sessions, total }
          return jsonResponse({ sessions: result.costs, total: result.total });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/sessions (create)
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as Record<string, unknown>;
          const result = await callRpc(router, "session/start", body);
          return jsonResponse({ ok: true, session: result.session });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/sessions
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        try {
          const result = await callRpc(router, "session/list", { limit: 200 });
          return jsonResponse(result.sessions);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/webhooks/github/issues
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
          const result = await handleIssueWebhook(payload, config);
          return jsonResponse(result, result.ok ? 200 : 400);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/sessions/import
      if (url.pathname === "/api/sessions/import" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as SessionExport;
          if (body.version !== 1) return jsonResponse({ ok: false, message: "Unsupported export version" }, 400);
          const session = getApp().sessions.create({
            ticket: body.session.ticket,
            summary: body.session.summary ? `[imported] ${body.session.summary}` : "[imported session]",
            repo: body.session.repo,
            flow: body.session.flow,
            config: body.session.config,
            group_name: body.session.group_name,
          });
          if (body.session.agent) getApp().sessions.update(session.id, { agent: body.session.agent });
          return jsonResponse({ ok: true, sessionId: session.id, message: `Imported as ${session.id}` });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // Session-specific routes: /api/sessions/:id/...
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(.+)$/);
      if (sessionMatch) {
        const [, id, action] = sessionMatch;

        // GET actions on sessions
        if (action === "output" && req.method === "GET") {
          try {
            const result = await callRpc(router, "session/output", { sessionId: id });
            return jsonResponse({ ok: true, output: result.output });
          } catch (err) {
            return errorResponse(err);
          }
        }

        if (action === "events" && req.method === "GET") {
          try {
            const result = await callRpc(router, "session/events", { sessionId: id });
            return jsonResponse(result.events);
          } catch (err) {
            return errorResponse(err);
          }
        }

        if (action === "export" && req.method === "GET") {
          try {
            const data = exportSession(id);
            if (!data) return jsonResponse({ error: "Not found" }, 404);
            return jsonResponse(data);
          } catch (err) {
            return errorResponse(err);
          }
        }

        if (action === "todos" && req.method === "GET") {
          try {
            const result = await callRpc(router, "todo/list", { sessionId: id });
            return jsonResponse(result.todos);
          } catch (err) {
            return errorResponse(err);
          }
        }

        if (action === "messages" && req.method === "GET") {
          try {
            const result = await callRpc(router, "session/messages", { sessionId: id });
            return jsonResponse(result);
          } catch (err) {
            return errorResponse(err);
          }
        }

        // POST actions on sessions
        if (req.method === "POST") {
          if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);

          try {
            switch (action) {
              case "dispatch": {
                const result = await callRpc(router, "session/dispatch", { sessionId: id });
                return jsonResponse(result);
              }
              case "stop": {
                const result = await callRpc(router, "session/stop", { sessionId: id });
                return jsonResponse(result);
              }
              case "restart": {
                const result = await callRpc(router, "session/resume", { sessionId: id });
                return jsonResponse(result);
              }
              case "delete": {
                const result = await callRpc(router, "session/delete", { sessionId: id });
                return jsonResponse(result);
              }
              case "undelete": {
                const result = await callRpc(router, "session/undelete", { sessionId: id });
                return jsonResponse(result);
              }
              case "fork": {
                const body = await req.json() as { name?: string };
                const result = await callRpc(router, "session/clone", { sessionId: id, name: body?.name });
                // RPC returns { session }, but REST API returns { ok, sessionId }
                const session = result.session;
                return jsonResponse({ ok: true, sessionId: session?.id });
              }
              case "send": {
                const body = await req.json() as { message?: string };
                if (!body?.message) return jsonResponse({ ok: false, message: "message is required" }, 400);
                const result = await callRpc(router, "message/send", { sessionId: id, content: body.message });
                return jsonResponse(result);
              }
              case "pause": {
                const body = await req.json() as { reason?: string };
                const result = await callRpc(router, "session/pause", { sessionId: id, reason: body?.reason });
                return jsonResponse(result);
              }
              case "advance": {
                const result = await callRpc(router, "session/advance", { sessionId: id });
                return jsonResponse(result);
              }
              case "complete": {
                const result = await callRpc(router, "session/complete", { sessionId: id });
                return jsonResponse(result);
              }
              case "interrupt": {
                const result = await callRpc(router, "session/interrupt", { sessionId: id });
                return jsonResponse(result);
              }
              case "archive": {
                const result = await callRpc(router, "session/archive", { sessionId: id });
                return jsonResponse(result);
              }
              case "restore": {
                const result = await callRpc(router, "session/restore", { sessionId: id });
                return jsonResponse(result);
              }
              case "spawn-subagent": {
                const rawBody = await req.json() as { task?: string; agent?: string; model?: string; group_name?: string; extensions?: string[] };
                if (!rawBody?.task) return jsonResponse({ ok: false, message: "task is required" }, 400);
                const result = await callRpc(router, "session/spawn", {
                  sessionId: id,
                  task: rawBody.task,
                  agent: rawBody.agent,
                  model: rawBody.model,
                  group_name: rawBody.group_name,
                });
                return jsonResponse(result);
              }
              case "todos": {
                const body = await req.json() as { content?: string };
                if (!body?.content) return jsonResponse({ ok: false, message: "content is required" }, 400);
                const result = await callRpc(router, "todo/add", { sessionId: id, content: body.content });
                return jsonResponse({ ok: true, todo: result.todo });
              }
              case "verify": {
                const result = await callRpc(router, "verify/run", { sessionId: id });
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

      // Todo routes: /api/todos/:id/toggle, /api/todos/:id/delete
      const todoMatch = url.pathname.match(/^\/api\/todos\/(\d+)\/(toggle|delete)$/);
      if (todoMatch && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        const [, todoIdStr, todoAction] = todoMatch;
        const todoId = parseInt(todoIdStr, 10);
        try {
          if (todoAction === "toggle") {
            const result = await callRpc(router, "todo/toggle", { id: todoId });
            return jsonResponse({ ok: true, todo: result.todo });
          } else {
            const result = await callRpc(router, "todo/delete", { id: todoId });
            return jsonResponse(result);
          }
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/sessions/:id (detail)
      if (url.pathname.startsWith("/api/sessions/") && url.pathname.split("/").length === 4) {
        const id = url.pathname.split("/")[3];
        try {
          const result = await callRpc(router, "session/read", { sessionId: id, include: ["events"] });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err, 404);
        }
      }

      // --- Search ---

      // GET /api/search?q=<query>&limit=50
      if (url.pathname === "/api/search" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return jsonResponse({ ok: false, message: "q parameter is required" }, 400);
        try {
          const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
          const sessions = searchSessions(q, { limit });
          const transcripts = searchTranscripts(q, { limit });
          return jsonResponse({ sessions, transcripts });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/search/global?q=<query>
      if (url.pathname === "/api/search/global" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return jsonResponse({ ok: false, message: "q parameter is required" }, 400);
        try {
          const results = searchAllConversations(q);
          return jsonResponse(results);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- History (Claude Code transcripts) ---

      // GET /api/history/sessions
      if (url.pathname === "/api/history/sessions" && req.method === "GET") {
        try {
          const result = await callRpc(router, "history/list", {});
          return jsonResponse(result.items);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/history/refresh (incremental refresh + index)
      if (url.pathname === "/api/history/refresh" && req.method === "POST") {
        try {
          const result = await callRpc(router, "history/refresh-and-index", {});
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/history/rebuild (full rebuild: clear + refresh + index)
      if (url.pathname === "/api/history/rebuild" && req.method === "POST") {
        try {
          const result = await callRpc(router, "history/rebuild-fts", {});
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Profiles ---

      // GET /api/profiles
      if (url.pathname === "/api/profiles" && req.method === "GET") {
        try {
          const result = await callRpc(router, "profile/list");
          return jsonResponse(result.profiles);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/profiles
      if (url.pathname === "/api/profiles" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { name?: string; description?: string };
          if (!body?.name) return jsonResponse({ ok: false, message: "name is required" }, 400);
          const result = await callRpc(router, "profile/create", { name: body.name, description: body.description });
          return jsonResponse({ ok: true, profile: result.profile });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // DELETE /api/profiles/:name
      if (url.pathname.startsWith("/api/profiles/") && req.method === "DELETE") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const name = url.pathname.split("/")[3];
          await callRpc(router, "profile/delete", { name });
          return jsonResponse({ ok: true, message: "Deleted" });
        } catch (err) {
          return jsonResponse({ ok: false, message: "Not found" });
        }
      }

      // --- MCP / Tools ---

      // GET /api/tools?dir=<path>
      if (url.pathname === "/api/tools" && req.method === "GET") {
        try {
          const dir = url.searchParams.get("dir") ?? undefined;
          const result = await callRpc(router, "tools/list", { projectRoot: dir });
          return jsonResponse(result.tools);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/mcp/attach
      if (url.pathname === "/api/mcp/attach" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { dir?: string; name?: string; config?: Record<string, unknown> };
          if (!body?.dir || !body?.name || !body?.config) return jsonResponse({ ok: false, message: "dir, name, config are required" }, 400);
          // mcp/attach RPC expects sessionId + server object; the web route uses dir + name + config.
          // The web route has a different contract, so we call core directly here.
          const { addMcpServer } = await import("./tools.js");
          addMcpServer(body.dir, body.name, body.config);
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/mcp/detach
      if (url.pathname === "/api/mcp/detach" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { dir?: string; name?: string };
          if (!body?.dir || !body?.name) return jsonResponse({ ok: false, message: "dir, name are required" }, 400);
          // Same as attach -- web route uses dir+name, RPC uses sessionId+serverName
          const { removeMcpServer } = await import("./tools.js");
          removeMcpServer(body.dir, body.name);
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Skills ---

      // POST /api/skills (create)
      if (url.pathname === "/api/skills" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          const { saveSkill } = await import("./skill.js");
          saveSkill(body, body.scope);
          return jsonResponse({ ok: true, name: body.name });
        } catch (err) { return errorResponse(err); }
      }

      // DELETE /api/skills/:name
      if (url.pathname.match(/^\/api\/skills\/(.+)$/) && req.method === "DELETE") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const name = decodeURIComponent(url.pathname.split("/")[3]);
          const scope = url.searchParams.get("scope") as "project" | "global" | undefined || undefined;
          const { deleteSkill } = await import("./skill.js");
          deleteSkill(name, scope);
          return jsonResponse({ ok: true });
        } catch (err) { return errorResponse(err); }
      }

      // GET /api/skills
      if (url.pathname === "/api/skills" && req.method === "GET") {
        try {
          const result = await callRpc(router, "skill/list");
          return jsonResponse(result.skills);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Recipes ---

      // DELETE /api/recipes/:name
      if (url.pathname.match(/^\/api\/recipes\/(.+)$/) && req.method === "DELETE") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const name = decodeURIComponent(url.pathname.split("/")[3]);
          const scope = url.searchParams.get("scope") as "project" | "global" || "global";
          const { deleteRecipe } = await import("./recipe.js");
          deleteRecipe(name, scope);
          return jsonResponse({ ok: true });
        } catch (err) { return errorResponse(err); }
      }

      // GET /api/recipes
      if (url.pathname === "/api/recipes" && req.method === "GET") {
        try {
          const result = await callRpc(router, "recipe/list");
          return jsonResponse(result.recipes);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Agents & Flows ---

      // POST /api/agents (create) -- no RPC handler for agent save
      if (url.pathname === "/api/agents" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          const { saveAgent } = await import("./agent.js");
          saveAgent(body);
          return jsonResponse({ ok: true, name: body.name });
        } catch (err) { return errorResponse(err); }
      }

      // PUT /api/agents/:name (update) -- no RPC handler for agent save
      if (url.pathname.match(/^\/api\/agents\/(.+)$/) && req.method === "PUT") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const name = decodeURIComponent(url.pathname.split("/")[3]);
          const body = await req.json() as any;
          const { saveAgent } = await import("./agent.js");
          saveAgent({ ...body, name });
          return jsonResponse({ ok: true, name });
        } catch (err) { return errorResponse(err); }
      }

      // DELETE /api/agents/:name -- no RPC handler for agent delete
      if (url.pathname.match(/^\/api\/agents\/(.+)$/) && req.method === "DELETE") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const name = decodeURIComponent(url.pathname.split("/")[3]);
          const { deleteAgent } = await import("./agent.js");
          deleteAgent(name);
          return jsonResponse({ ok: true });
        } catch (err) { return errorResponse(err); }
      }

      // GET /api/agents
      if (url.pathname === "/api/agents" && req.method === "GET") {
        try {
          const result = await callRpc(router, "agent/list");
          return jsonResponse(result.agents);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/flows (create)
      if (url.pathname === "/api/flows" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          const { saveFlow } = await import("./flow.js");
          saveFlow(body);
          return jsonResponse({ ok: true, name: body.name });
        } catch (err) { return errorResponse(err); }
      }

      // DELETE /api/flows/:name
      if (url.pathname.match(/^\/api\/flows\/[^/]+$/) && req.method === "DELETE") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const name = decodeURIComponent(url.pathname.split("/")[3]);
          // Prevent deleting builtin flows
          const { listFlows, deleteFlow } = await import("./flow.js");
          const all = listFlows();
          const flow = all.find(f => f.name === name);
          if (flow && flow.source === "builtin") {
            return jsonResponse({ ok: false, message: "Cannot delete builtin flows" }, 400);
          }
          deleteFlow(name);
          return jsonResponse({ ok: true });
        } catch (err) { return errorResponse(err); }
      }

      // GET /api/flows
      if (url.pathname === "/api/flows" && req.method === "GET") {
        try {
          const result = await callRpc(router, "flow/list");
          return jsonResponse(result.flows);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/flows/:name (flow detail with stages)
      const flowDetailMatch = url.pathname.match(/^\/api\/flows\/([^/]+)$/);
      if (flowDetailMatch && req.method === "GET") {
        try {
          const name = decodeURIComponent(flowDetailMatch[1]);
          const result = await callRpc(router, "flow/read", { name });
          const flow = result.flow;
          return jsonResponse({
            name: flow.name,
            stages: (flow.stages ?? []).map((st: any) => ({
              name: st.name, gate: st.gate, agent: st.agent, type: st.type,
            })),
          });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Worktrees ---

      // GET /api/worktrees
      if (url.pathname === "/api/worktrees" && req.method === "GET") {
        try {
          const sessions = getApp().sessions.list({ limit: 500 });
          const withWorktrees = sessions.filter(s => s.workdir && s.branch);
          return jsonResponse(withWorktrees);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/worktrees/:id/diff
      if (url.pathname.match(/^\/api\/worktrees\/([^/]+)\/diff$/) && req.method === "GET") {
        try {
          const id = url.pathname.split("/")[3];
          const base = url.searchParams.get("base") ?? undefined;
          const result = await callRpc(router, "worktree/diff", { sessionId: id, base });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/worktrees/:id/finish
      const wtFinishMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/finish$/);
      if (wtFinishMatch && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { into?: string; noMerge?: boolean; keepBranch?: boolean };
          const result = await callRpc(router, "worktree/finish", { sessionId: wtFinishMatch[1], noMerge: body?.noMerge });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/worktrees/:id/create-pr
      const wtCreatePRMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/create-pr$/);
      if (wtCreatePRMatch && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { title?: string; body?: string; base?: string; draft?: boolean };
          const result = await callRpc(router, "worktree/create-pr", { sessionId: wtCreatePRMatch[1], ...body });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/worktrees/cleanup -- no RPC equivalent
      if (url.pathname === "/api/worktrees/cleanup" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const result = await cleanupWorktrees();
          return jsonResponse({ ok: true, ...result });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Conductor / Learnings (no RPC equivalents) ---

      // GET /api/conductor/learnings
      if (url.pathname === "/api/conductor/learnings" && req.method === "GET") {
        try {
          const dir = url.searchParams.get("dir") ?? ".";
          return jsonResponse(getLearnings(dir));
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/conductor/learn
      if (url.pathname === "/api/conductor/learn" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { title?: string; description?: string; dir?: string };
          if (!body?.title || !body?.description) return jsonResponse({ ok: false, message: "title and description are required" }, 400);
          const dir = body.dir ?? ".";
          const result = recordLearning(dir, body.title, body.description);
          return jsonResponse({ ok: true, ...result });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Memory ---

      // GET /api/memory
      if (url.pathname === "/api/memory" && req.method === "GET") {
        try {
          const scope = url.searchParams.get("scope") ?? undefined;
          const result = await callRpc(router, "memory/list", { scope });
          return jsonResponse(result.memories);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/memory/recall?q=<query>
      if (url.pathname === "/api/memory/recall" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return jsonResponse({ ok: false, message: "q parameter is required" }, 400);
        try {
          const result = await callRpc(router, "memory/recall", { query: q });
          return jsonResponse(result.results);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/memory
      if (url.pathname === "/api/memory" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { content?: string; scope?: string; tags?: string[] };
          if (!body?.content) return jsonResponse({ ok: false, message: "content is required" }, 400);
          const result = await callRpc(router, "memory/add", { content: body.content, scope: body.scope, tags: body.tags });
          return jsonResponse({ ok: true, entry: result.memory });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // DELETE /api/memory/:id
      if (url.pathname.startsWith("/api/memory/") && url.pathname !== "/api/memory/recall" && req.method === "DELETE") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const id = url.pathname.split("/")[3];
          const result = await callRpc(router, "memory/forget", { id });
          return jsonResponse({ ok: result.ok, message: result.ok ? "Forgotten" : "Not found" });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Knowledge (no RPC equivalent) ---

      // POST /api/knowledge/ingest
      if (url.pathname === "/api/knowledge/ingest" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { path?: string; directory?: boolean; scope?: string; tags?: string[]; recursive?: boolean };
          if (!body?.path) return jsonResponse({ ok: false, message: "path is required" }, 400);
          if (body.directory) {
            const result = ingestDirectory(body.path, { scope: body.scope, tags: body.tags, recursive: body.recursive });
            return jsonResponse({ ok: true, ...result });
          }
          const chunks = ingestFile(body.path, { scope: body.scope, tags: body.tags });
          return jsonResponse({ ok: true, chunks });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Compute ---

      // POST /api/compute (create)
      if (url.pathname === "/api/compute" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          if (!body?.name || !body?.provider) return jsonResponse({ ok: false, message: "name and provider are required" }, 400);
          const result = await callRpc(router, "compute/create", body as Record<string, unknown>);
          return jsonResponse({ ok: true, compute: result.compute });
        } catch (err) { return errorResponse(err); }
      }

      // GET /api/compute
      if (url.pathname === "/api/compute" && req.method === "GET") {
        try {
          const result = await callRpc(router, "compute/list");
          return jsonResponse(result.targets);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/compute/:name/:action
      const computeActionMatch = url.pathname.match(/^\/api\/compute\/([^/]+)\/(provision|start|stop|destroy|delete)$/);
      if (computeActionMatch && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        const [, computeName, computeAction] = computeActionMatch;
        try {
          const rpcMethod =
            computeAction === "start" ? "compute/start-instance" :
            computeAction === "stop" ? "compute/stop-instance" :
            `compute/${computeAction}`;
          const result = await callRpc(router, rpcMethod, { name: computeName });
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/compute/:name
      if (url.pathname.startsWith("/api/compute/") && req.method === "GET") {
        try {
          const name = url.pathname.split("/")[3];
          const result = await callRpc(router, "compute/read", { name });
          return jsonResponse(result.compute);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Schedules ---

      // GET /api/schedules
      if (url.pathname === "/api/schedules" && req.method === "GET") {
        try {
          const result = await callRpc(router, "schedule/list");
          return jsonResponse(result.schedules);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/schedules
      if (url.pathname === "/api/schedules" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as { cron?: string; flow?: string; repo?: string; workdir?: string; summary?: string; compute_name?: string; group_name?: string };
          if (!body?.cron) return jsonResponse({ ok: false, message: "cron is required" }, 400);
          const result = await callRpc(router, "schedule/create", body);
          return jsonResponse({ ok: true, schedule: result.schedule });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/schedules/:id/delete
      const schedDeleteMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/delete$/);
      if (schedDeleteMatch && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const result = await callRpc(router, "schedule/delete", { id: schedDeleteMatch[1] });
          return jsonResponse({ ok: result.ok, message: result.ok ? "Deleted" : "Not found" });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/schedules/:id/enable
      const schedEnableMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/enable$/);
      if (schedEnableMatch && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          await callRpc(router, "schedule/enable", { id: schedEnableMatch[1] });
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/schedules/:id/disable
      const schedDisableMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/disable$/);
      if (schedDisableMatch && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          await callRpc(router, "schedule/disable", { id: schedDisableMatch[1] });
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Repo Map (no RPC equivalent) ---

      // GET /api/repo-map?dir=<path>
      if (url.pathname === "/api/repo-map" && req.method === "GET") {
        try {
          const dir = url.searchParams.get("dir") ?? ".";
          return jsonResponse(generateRepoMap(dir));
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- System Config ---

      // GET /api/config
      if (url.pathname === "/api/config" && req.method === "GET") {
        try {
          return jsonResponse({
            hotkeys: getHotkeys(),
            theme: getThemeMode(),
            profile: getActiveProfile(),
          });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // Static file serving for web frontend (skip in API-only mode)
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

      // Dashboard HTML -- serve index.html only for root path
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
      unsubEventBus();
      for (const client of sseClients) {
        try { client.close(); } catch { /* ignore */ }
      }
      sseClients.clear();
      server.stop();
    },
  };
}
