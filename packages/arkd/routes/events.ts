/**
 * /hooks/forward + /events/stream routes.
 *
 * Replaces the SSH `-R 19100:localhost:19100` reverse tunnel that
 * carried hook callbacks from the agent back to the conductor. The new
 * shape uses the same direction as every other arkd request (conductor
 * pulls from arkd over the forward `-L` tunnel) and the same chunked-
 * HTTP pattern as `/agent/attach/stream`:
 *
 *   - Agent's launcher hooks POST to `http://localhost:<arkd>/hooks/forward`
 *     -- always reachable because arkd runs on the same host as the agent.
 *     The handler enqueues the JSON body (plus `?session=<id>` and any
 *     query string) into an in-memory ring.
 *
 *   - Conductor calls `GET /events/stream` once when a remote compute is
 *     ready. The response stays open and yields one NDJSON line per
 *     event drained from the ring. Conductor pipes each line into the
 *     existing `/hooks/status` handler shape so nothing downstream
 *     changes.
 *
 * Module-scoped state: there is exactly one event ring per arkd
 * process. arkd is single-tenant single-compute by deployment shape,
 * so a global queue is the right granularity. The ring is bounded
 * (`MAX_QUEUED_EVENTS`) so an unread queue can't OOM; oldest events
 * drop first and the next reader sees a `dropped` notice as the first
 * frame.
 */

import { json, type RouteCtx } from "../internal.js";
import { logDebug, logInfo, logWarn } from "../../core/observability/structured-log.js";

/** One enqueued hook event. */
interface QueuedEvent {
  /** Wire kind. `hook` is the only one today; future: `channel`, `progress`. */
  kind: "hook";
  /** Optional session id from `?session=<id>` -- echoed to the conductor. */
  session: string | null;
  /** Original query string (everything after `?`) so the consumer can
   *  reconstruct the URL parameters the conductor's handler expects. */
  query: string;
  /** Parsed JSON body. Conductor re-serialises it on its end. */
  body: unknown;
  /** Wall-clock at enqueue. */
  ts: string;
}

/**
 * Bound on the in-memory queue. ~10k events is well past any single
 * dispatch (a single agent run produces ~100-1000 hook events). When
 * the cap is hit we drop oldest first and increment `droppedSince`
 * which is published as a synthetic event on the next stream.
 */
const MAX_QUEUED_EVENTS = 10_000;

/**
 * Module-scoped queue + waiter. Exported helpers for tests; the route
 * handler closes over `state` directly.
 */
interface EventBus {
  ring: QueuedEvent[];
  droppedSince: number;
  waiters: Array<() => void>;
}
const state: EventBus = { ring: [], droppedSince: 0, waiters: [] };

function enqueue(ev: QueuedEvent): void {
  state.ring.push(ev);
  if (state.ring.length > MAX_QUEUED_EVENTS) {
    const overflow = state.ring.length - MAX_QUEUED_EVENTS;
    state.ring.splice(0, overflow);
    state.droppedSince += overflow;
    logWarn("compute", `arkd events: queue overflow, dropped ${overflow} oldest events`);
  }
  // Wake every waiter -- they re-check the queue and either drain or
  // re-park. The drain is async so racy double-wakes are harmless.
  const w = state.waiters.splice(0, state.waiters.length);
  for (const fn of w) fn();
}

/** Test-only: reset module state between tests. */
export function _resetEventBus(): void {
  state.ring.length = 0;
  state.droppedSince = 0;
  state.waiters.length = 0;
}

/**
 * Resolve when one or more events are available, or `signal` aborts.
 * Used by the streaming response loop to park between drains.
 */
function waitForEvent(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (state.ring.length > 0) return resolve();
    const wake = (): void => resolve();
    state.waiters.push(wake);
    signal.addEventListener("abort", () => {
      const idx = state.waiters.indexOf(wake);
      if (idx >= 0) state.waiters.splice(idx, 1);
      resolve();
    });
  });
}

/** Encode one event as an NDJSON line (newline-terminated JSON). */
function ndjsonLine(payload: unknown): Uint8Array {
  const text = JSON.stringify(payload) + "\n";
  return new TextEncoder().encode(text);
}

export async function handleEventsRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
  // ── Producer: agent hook -> queue ──────────────────────────────────
  if (req.method === "POST" && path === "/hooks/forward") {
    const url = new URL(req.url);
    const session = url.searchParams.get("session");
    const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    enqueue({ kind: "hook", session, query, body, ts: new Date().toISOString() });
    return json({ ok: true });
  }

  // ── Consumer: conductor long-poll stream ───────────────────────────
  if (req.method === "GET" && path === "/events/stream") {
    const ac = new AbortController();
    // Bun forwards the request abort signal via `req.signal`, so when
    // the conductor disconnects we get a clean teardown without leaking
    // the streaming loop.
    req.signal.addEventListener("abort", () => ac.abort());

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        logInfo("compute", "arkd events: stream opened");
        // Run the drain loop as a detached async task so `start()`
        // returns immediately and Bun starts pumping bytes to the
        // wire as soon as `controller.enqueue` runs. Awaiting here
        // would buffer everything until the loop exits.
        void (async () => {
          try {
            // Surface any pre-existing drop count as the first line
            // so the conductor can mark affected sessions "may be
            // missing events" without threading it through every
            // subsequent envelope.
            if (state.droppedSince > 0) {
              controller.enqueue(
                ndjsonLine({ kind: "dropped", count: state.droppedSince, ts: new Date().toISOString() }),
              );
              state.droppedSince = 0;
            }
            while (!ac.signal.aborted) {
              while (state.ring.length > 0 && !ac.signal.aborted) {
                const ev = state.ring.shift()!;
                try {
                  controller.enqueue(ndjsonLine(ev));
                } catch {
                  logDebug("compute", "arkd events: enqueue threw, stream likely closed");
                  ac.abort();
                  break;
                }
              }
              if (ac.signal.aborted) break;
              await waitForEvent(ac.signal);
            }
          } finally {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            logInfo("compute", "arkd events: stream closed");
          }
        })();
      },
      cancel() {
        ac.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
        // Prevent any intermediate proxy from buffering chunks. We
        // own the network path end-to-end (forward `-L` tunnel) so
        // none should be in the way, but be explicit anyway.
        "X-Accel-Buffering": "no",
      },
    });
  }

  return null;
}
