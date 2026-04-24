/**
 * REST GET handlers for `/api/sessions`, `/api/events`, forensic files,
 * and the `/api/sessions/:id/tree/stream` SSE endpoint.
 */

import type { AppContext } from "../app.js";
import { appForRequest } from "./tenant.js";
import { eventBus } from "../hooks.js";
import { readForensicFile } from "../services/session-forensic.js";

/** Extract a path segment by index, returning null if missing. */
function extractPathSegment(path: string, index: number): string | null {
  return path.split("/")[index] ?? null;
}

export async function handleRestApi(app: AppContext, req: Request, path: string): Promise<Response> {
  if (path === "/health") {
    return Response.json({
      status: "ok",
      arkDir: app.config.dirs.ark,
    });
  }

  const resolved = await appForRequest(app, req);
  if (resolved.ok === false) return resolved.response;
  const scoped = resolved.app;

  if (path === "/api/sessions") {
    const url = new URL(req.url);
    // `?roots=true` activates the tree-aware list path (rootsOnly + child_stats).
    // Preserves the flat default for existing callers that don't pass the flag.
    if (url.searchParams.get("roots") === "true") {
      return Response.json(await scoped.sessions.listRoots());
    }
    return Response.json(await scoped.sessions.list());
  }
  if (path.startsWith("/api/sessions/")) {
    const id = extractPathSegment(path, 3);
    if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
    const sub = extractPathSegment(path, 4);
    // ── /api/sessions/:id/tree/stream -- SSE debounced tree deltas ──
    if (sub === "tree" && extractPathSegment(path, 5) === "stream") {
      return handleTreeStream(scoped, id);
    }
    // ── /api/sessions/:id/tree -- recursive tree snapshot ───────────
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
    // ── /api/sessions/:id/children -- direct children with stats ────
    if (sub === "children") {
      const existing = await scoped.sessions.get(id);
      if (!existing) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ sessions: await scoped.sessions.listChildren(id) });
    }
    // ── /api/sessions/:id/stdio | /transcript -- forensic files ─────
    // The session must exist (404 otherwise); the file may not yet
    // (200 with an empty body). Respects a 2MB cap with ?tail=<N> for
    // long-running sessions.
    if (sub === "stdio" || sub === "transcript") {
      const s = await scoped.sessions.get(id);
      if (!s) return Response.json({ error: "not found" }, { status: 404 });
      const innerUrl = new URL(req.url);
      const rawTail = innerUrl.searchParams.get("tail");
      const tail = rawTail != null ? Number(rawTail) : undefined;
      if (rawTail != null && (!Number.isFinite(tail) || (tail as number) <= 0)) {
        return Response.json({ error: "tail must be a positive integer" }, { status: 400 });
      }
      const fileName = sub === "stdio" ? "stdio.log" : "transcript.jsonl";
      const read = await readForensicFile(scoped.config.tracksDir, id, fileName, { tail });
      if (read.tooLarge) {
        return Response.json(
          { error: `file is ${read.size} bytes, over the 2MB cap -- use ?tail=<N> to read the tail` },
          { status: 413 },
        );
      }
      const contentType = sub === "stdio" ? "text/plain; charset=utf-8" : "application/x-ndjson; charset=utf-8";
      return new Response(read.content, { status: 200, headers: { "Content-Type": contentType } });
    }
    if (sub) return Response.json({ error: "not found" }, { status: 404 });
    const s = await scoped.sessions.get(id);
    return s ? Response.json(s) : Response.json({ error: "not found" }, { status: 404 });
  }
  if (path.startsWith("/api/events/")) {
    const id = extractPathSegment(path, 3);
    if (!id) return Response.json({ error: "missing session id" }, { status: 400 });
    if (!(await scoped.sessions.get(id))) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(await scoped.events.list(id));
  }
  return new Response("Not found", { status: 404 });
}

/**
 * SSE stream that emits an initial `tree-update` snapshot on connect, then
 * debounced `tree-update` deltas whenever any descendant's status changes
 * (via the `hook_status` event) or a new descendant session is created.
 *
 * Scoped to the tenant-resolved `app` so cross-tenant fan-out cannot leak
 * across streams. Unsubscribes from the bus when the client disconnects.
 */
export function handleTreeStream(app: AppContext, rootId: string): Response {
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
          // Controller closed mid-send.
        }
      };

      // Collect descendant ids so we can filter bus events to this tree.
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

      // Initial snapshot.
      await pushSnapshot();

      const scheduleSnapshot = () => {
        if (debounceTimer) return;
        debounceTimer = setTimeout(async () => {
          debounceTimer = null;
          await pushSnapshot();
        }, DEBOUNCE_MS);
      };

      unsub = eventBus.onAll((evt) => {
        // Listen for status + cost-relevant events. `session_created` is
        // always eligible (a new child may need to join the tree); other
        // events are gated on tree membership.
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
