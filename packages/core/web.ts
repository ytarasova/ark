/**
 * Web UI dashboard — browser-based session management.
 * Serves static React SPA from packages/web/dist/ + JSON API + SSE live updates on a single port.
 *
 * All data is read from the local SQLite store (no external/untrusted input).
 * Build the frontend with: bun run packages/web/build.ts
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { listSessions, getSession, getEvents, getGroups, createSession, updateSession, listCompute, getCompute, type Session } from "./store.js";
import { getAllSessionCosts, formatCost } from "./costs.js";
import { handleIssueWebhook, type IssueWebhookConfig } from "./github-webhook.js";
import {
  startSession,
  dispatch,
  stop,
  resume,
  deleteSessionAsync,
  undeleteSessionAsync,
  getOutput,
  cloneSession,
  send,
  pause,
  advance,
  complete,
  spawnSubagent,
  finishWorktree,
  cleanupWorktrees,
} from "./session.js";
import { exportSession, type SessionExport } from "./session-share.js";
import { searchSessions, searchTranscripts } from "./search.js";
import { searchAllConversations } from "./global-search.js";
import { listProfiles, createProfile, deleteProfile, getActiveProfile } from "./profiles.js";
import { discoverTools, addMcpServer, removeMcpServer } from "./tools.js";
import { listSkills } from "./skill.js";
import { listRecipes } from "./recipe.js";
import { listAgents } from "./agent.js";
import { listFlows } from "./flow.js";
import { getLearnings, recordLearning } from "./learnings.js";
import { listMemories, recall, remember, forget } from "./memory.js";
import { ingestFile, ingestDirectory } from "./knowledge.js";
import { generateRepoMap } from "./repo-map.js";
import { getHotkeys } from "./hotkeys.js";
import { getThemeMode } from "./theme.js";

// Static file serving for the web frontend
const WEB_DIST = join(import.meta.dir, "../../packages/web/dist");

export interface WebServerOptions {
  port?: number;
  readOnly?: boolean;
  token?: string;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

      // GET /api/costs/export
      if (url.pathname === "/api/costs/export" && req.method === "GET") {
        const format = url.searchParams.get("format") ?? "json";
        const sessions = listSessions({ limit: 500 });
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

      // POST /api/webhooks/github/issues
      if (url.pathname === "/api/webhooks/github/issues" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const payload = await req.json() as any;
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
          const session = createSession({
            ticket: body.session.ticket,
            summary: body.session.summary ? `[imported] ${body.session.summary}` : "[imported session]",
            repo: body.session.repo,
            flow: body.session.flow,
            config: body.session.config,
            group_name: body.session.group_name,
          });
          if (body.session.agent) updateSession(session.id, { agent: body.session.agent });
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
            const output = await getOutput(id);
            return jsonResponse({ ok: true, output });
          } catch (err) {
            return errorResponse(err);
          }
        }

        if (action === "events" && req.method === "GET") {
          try {
            return jsonResponse(getEvents(id));
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

        // POST actions on sessions
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
              case "fork": {
                const body = await req.json() as any;
                const result = cloneSession(id, body?.name);
                return jsonResponse(result);
              }
              case "send": {
                const body = await req.json() as any;
                if (!body?.message) return jsonResponse({ ok: false, message: "message is required" }, 400);
                const result = await send(id, body.message);
                return jsonResponse(result);
              }
              case "pause": {
                const body = await req.json() as any;
                const result = pause(id, body?.reason);
                return jsonResponse(result);
              }
              case "advance": {
                const result = advance(id);
                return jsonResponse(result);
              }
              case "complete": {
                const result = complete(id);
                return jsonResponse(result);
              }
              case "spawn-subagent": {
                const body = await req.json() as any;
                if (!body?.task) return jsonResponse({ ok: false, message: "task is required" }, 400);
                const result = spawnSubagent(id, body);
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
      if (url.pathname.startsWith("/api/sessions/") && url.pathname.split("/").length === 4) {
        const id = url.pathname.split("/")[3];
        const session = getSession(id);
        if (!session) return jsonResponse({ error: "Not found" }, 404);
        const events = getEvents(id);
        return jsonResponse({ session, events });
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

      // --- Profiles ---

      // GET /api/profiles
      if (url.pathname === "/api/profiles" && req.method === "GET") {
        return jsonResponse(listProfiles());
      }

      // POST /api/profiles
      if (url.pathname === "/api/profiles" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          if (!body?.name) return jsonResponse({ ok: false, message: "name is required" }, 400);
          const profile = createProfile(body.name, body.description);
          return jsonResponse({ ok: true, profile });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // DELETE /api/profiles/:name
      if (url.pathname.startsWith("/api/profiles/") && req.method === "DELETE") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const name = url.pathname.split("/")[3];
          const ok = deleteProfile(name);
          return jsonResponse({ ok, message: ok ? "Deleted" : "Not found" });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- MCP / Tools ---

      // GET /api/tools?dir=<path>
      if (url.pathname === "/api/tools" && req.method === "GET") {
        try {
          const dir = url.searchParams.get("dir") ?? undefined;
          return jsonResponse(discoverTools(dir));
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/mcp/attach
      if (url.pathname === "/api/mcp/attach" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          if (!body?.dir || !body?.name || !body?.config) return jsonResponse({ ok: false, message: "dir, name, config are required" }, 400);
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
          const body = await req.json() as any;
          if (!body?.dir || !body?.name) return jsonResponse({ ok: false, message: "dir, name are required" }, 400);
          removeMcpServer(body.dir, body.name);
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Skills ---

      // GET /api/skills
      if (url.pathname === "/api/skills" && req.method === "GET") {
        try {
          return jsonResponse(listSkills());
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Recipes ---

      // GET /api/recipes
      if (url.pathname === "/api/recipes" && req.method === "GET") {
        try {
          return jsonResponse(listRecipes());
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Agents & Flows ---

      // GET /api/agents
      if (url.pathname === "/api/agents" && req.method === "GET") {
        try {
          return jsonResponse(listAgents());
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/flows
      if (url.pathname === "/api/flows" && req.method === "GET") {
        try {
          return jsonResponse(listFlows());
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Worktrees ---

      // GET /api/worktrees
      if (url.pathname === "/api/worktrees" && req.method === "GET") {
        try {
          const sessions = listSessions({ limit: 500 });
          const withWorktrees = sessions.filter(s => s.workdir && s.branch);
          return jsonResponse(withWorktrees);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/worktrees/:id/finish
      const wtFinishMatch = url.pathname.match(/^\/api\/worktrees\/([^/]+)\/finish$/);
      if (wtFinishMatch && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          const result = await finishWorktree(wtFinishMatch[1], body);
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/worktrees/cleanup
      if (url.pathname === "/api/worktrees/cleanup" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const result = await cleanupWorktrees();
          return jsonResponse({ ok: true, ...result });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Conductor / Learnings ---

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
          const body = await req.json() as any;
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
          return jsonResponse(listMemories(scope));
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/memory/recall?q=<query>
      if (url.pathname === "/api/memory/recall" && req.method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return jsonResponse({ ok: false, message: "q parameter is required" }, 400);
        try {
          return jsonResponse(recall(q));
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/memory
      if (url.pathname === "/api/memory" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          if (!body?.content) return jsonResponse({ ok: false, message: "content is required" }, 400);
          const entry = remember(body.content, body);
          return jsonResponse({ ok: true, entry });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // DELETE /api/memory/:id
      if (url.pathname.startsWith("/api/memory/") && url.pathname !== "/api/memory/recall" && req.method === "DELETE") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const id = url.pathname.split("/")[3];
          const ok = forget(id);
          return jsonResponse({ ok, message: ok ? "Forgotten" : "Not found" });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Knowledge ---

      // POST /api/knowledge/ingest
      if (url.pathname === "/api/knowledge/ingest" && req.method === "POST") {
        if (readOnly) return jsonResponse({ ok: false, message: "Read-only mode" }, 403);
        try {
          const body = await req.json() as any;
          if (!body?.path) return jsonResponse({ ok: false, message: "path is required" }, 400);
          if (body.directory) {
            const result = ingestDirectory(body.path, body);
            return jsonResponse({ ok: true, ...result });
          }
          const chunks = ingestFile(body.path, body);
          return jsonResponse({ ok: true, chunks });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Compute ---

      // GET /api/compute
      if (url.pathname === "/api/compute" && req.method === "GET") {
        try {
          return jsonResponse(listCompute());
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/compute/:name
      if (url.pathname.startsWith("/api/compute/") && req.method === "GET") {
        try {
          const name = url.pathname.split("/")[3];
          const compute = getCompute(name);
          if (!compute) return jsonResponse({ error: "Not found" }, 404);
          return jsonResponse(compute);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // --- Repo Map ---

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

