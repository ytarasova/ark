/**
 * Test utility: start a minimal HTTP server that serves the external REST
 * routes previously exposed by the old conductor, now served by the merged
 * server daemon on port 19400.
 *
 * Used by tests that were written against the old `startConductor(app, port)`
 * API to POST to `/hooks/status`, `/api/channel/:id`, etc. The merged server
 * surfaces these routes on the same Bun.serve instance as the JSON-RPC
 * WebSocket handler.
 *
 * Returns a handle with a `stop()` method to match the old
 * `ConductorHandle` interface.
 */

import type { AppContext } from "../../app.js";
import { handleReport } from "../../services/channel/report-pipeline.js";
import { handleHookStatusHttp } from "../../services/channel/hook-status-http.js";
import type { OutboundMessage } from "../../services/channel/channel-types.js";
import { appForRequest } from "../../services/channel/tenant.js";
import { eventBus } from "../../hooks.js";
import { readForensicFile } from "../../services/session-forensic.js";

/** Back-compat alias for old `ConductorHandle` interface used in tests. */
export interface ConductorHandle {
  stop(): void;
}

export type TestServerHandle = ConductorHandle;

/**
 * Start a test HTTP server that mimics the old conductor REST surface.
 *
 * Serves:
 *   POST /hooks/status?session=<id>  -- hook event processing
 *   POST /api/channel/:sessionId     -- channel report delivery
 *   GET  /health                     -- liveness
 *
 * The server binds to `127.0.0.1:<port>` so it doesn't conflict with the
 * production daemon on port 19400.
 */
export function startTestServer(app: AppContext, port: number): TestServerHandle {
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return Response.json({ status: "ok" });
      }

      if (req.method === "POST" && path === "/hooks/status") {
        return handleHookStatusHttp(app, req, url);
      }

      if (req.method === "POST" && path.startsWith("/api/channel/")) {
        const sessionId = path.split("/")[3];
        if (!sessionId) return Response.json({ error: "missing session id" }, { status: 400 });
        try {
          const resolved = await appForRequest(app, req);
          if (resolved.ok === false) return resolved.response;
          const report = (await req.json()) as OutboundMessage;
          await handleReport(resolved.app, sessionId, report);
          return Response.json({ status: "ok" });
        } catch (e: any) {
          return Response.json({ error: String(e) }, { status: 500 });
        }
      }

      if (req.method === "POST" && path === "/api/relay") {
        return Response.json({ status: "ok" });
      }

      // REST GET routes (used by session-tree-rpc tests)
      if (req.method === "GET") {
        const resolved = await appForRequest(app, req);
        if (resolved.ok === false) return resolved.response;
        const scoped = resolved.app;

        if (path === "/health") {
          return Response.json({ status: "ok" });
        }

        if (path === "/api/sessions") {
          if (url.searchParams.get("roots") === "true") {
            return Response.json(await scoped.sessions.listRoots());
          }
          return Response.json(await scoped.sessions.list());
        }

        if (path.startsWith("/api/sessions/")) {
          const parts = path.split("/");
          const id = parts[3];
          const sub = parts[4];
          if (!id) return Response.json({ error: "missing session id" }, { status: 400 });

          if (sub === "tree" && parts[5] === "stream") {
            // SSE tree stream -- minimal implementation for tests
            return handleTreeStream(scoped, id);
          }
          if (sub === "tree") {
            const existing = await scoped.sessions.get(id);
            if (!existing) return Response.json({ error: "not found" }, { status: 404 });
            try {
              const root = await scoped.sessions.loadTree(id);
              return Response.json({ root });
            } catch (e: any) {
              return Response.json({ error: String(e?.message ?? e) }, { status: 400 });
            }
          }
          if (sub === "children") {
            const existing = await scoped.sessions.get(id);
            if (!existing) return Response.json({ error: "not found" }, { status: 404 });
            return Response.json({ sessions: await scoped.sessions.listChildren(id) });
          }
          if (sub === "stdio" || sub === "transcript") {
            const s = await scoped.sessions.get(id);
            if (!s) return Response.json({ error: "not found" }, { status: 404 });
            const rawTail = url.searchParams.get("tail");
            const tail = rawTail != null ? Number(rawTail) : undefined;
            const fileName = sub === "stdio" ? "stdio.log" : "transcript.jsonl";
            const read = await readForensicFile(scoped.config.dirs.tracks, id, fileName, { tail });
            if (read.tooLarge) {
              return Response.json(
                { error: `File too large (${read.size} bytes). Use ?tail=<N> to read the last N lines.` },
                { status: 413 },
              );
            }
            if (!read.exists) return new Response("", { status: 200 });
            const contentType = sub === "stdio" ? "text/plain; charset=utf-8" : "application/x-ndjson; charset=utf-8";
            return new Response(read.content, { status: 200, headers: { "Content-Type": contentType } });
          }
          if (!sub) {
            const s = await scoped.sessions.get(id);
            return s ? Response.json(s) : Response.json({ error: "not found" }, { status: 404 });
          }
        }

        if (path.startsWith("/api/events/")) {
          const id = path.split("/")[3];
          if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
          if (!(await scoped.sessions.get(id))) return Response.json({ error: "not found" }, { status: 404 });
          return Response.json(await scoped.events.list(id));
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    stop: () => server.stop(true),
  };
}

/**
 * SSE tree stream (minimal implementation for tests).
 * Matches the shape used by session-tree-rpc tests.
 */
function handleTreeStream(app: AppContext, rootId: string): Response {
  const DEBOUNCE_MS = 200;
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* Controller closed mid-send. */
        }
      };

      let descendantIds = new Set<string>();
      const rebuild = async (): Promise<unknown | null> => {
        try {
          const root = await app.sessions.loadTree(rootId);
          const next = new Set<string>();
          const walk = (n: { id: string; children: any[] }) => {
            next.add(n.id);
            for (const c of n.children) walk(c);
          };
          walk(root as any);
          descendantIds = next;
          return root;
        } catch (err: any) {
          send("error", { message: String(err?.message ?? err) });
          return null;
        }
      };

      const pushSnapshot = async () => {
        const root = await rebuild();
        if (root) send("tree-update", { root });
      };

      await pushSnapshot();

      const scheduleSnapshot = () => {
        if (debounceTimer) return;
        debounceTimer = setTimeout(async () => {
          debounceTimer = null;
          await pushSnapshot();
        }, DEBOUNCE_MS);
      };

      unsub = eventBus.onAll((evt) => {
        if (evt.type !== "hook_status" && evt.type !== "session_updated" && evt.type !== "session_created") return;
        if (evt.type !== "session_created" && !descendantIds.has(evt.sessionId)) return;
        scheduleSnapshot();
      });
    },
    cancel() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      unsub?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

/**
 * Back-compat alias for tests that used `startConductor(app, port)`.
 * The old conductor is merged into the server daemon; in tests we start
 * a minimal HTTP server with the same REST surface instead.
 */
export const startConductor = startTestServer;
