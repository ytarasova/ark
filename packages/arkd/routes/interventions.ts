/**
 * Intervention queue + stream: conductor -> agent steer-message bus.
 *
 * Mirrors the hook pipeline (`/hooks/forward` + `/events/stream`) but in the
 * opposite direction. Producers (conductor) POST to /agent/intervention?
 * session=<sid>; consumers (the claude-agent SDK loop) long-poll
 * /agent/interventions/stream?session=<sid> and receive each queued envelope
 * as one NDJSON line.
 *
 * Why an in-memory queue:
 *   - The agent connects via long-poll; arkd is the rendezvous.
 *   - Persistence is irrelevant -- a steer message that wasn't delivered while
 *     the agent was offline will be re-sent by the operator anyway, and
 *     replaying old steers on reconnect is more dangerous than dropping them.
 *   - Each session gets its own ring so a slow consumer for session A cannot
 *     starve session B.
 *
 * Why NDJSON over the same `ReadableStream` shape as /events/stream:
 *   - Identical framing means the SSM-tunnel buffering, conductor consumer
 *     code, and ops debugging steps all carry over.
 *   - One JSON object per line, terminated by \n. No SSE event-stream framing
 *     to avoid the SDK runtime needing an SSE parser.
 */

import { json, type RouteCtx, requireSafeTmuxName, SAFE_TMUX_NAME_RE } from "../internal.js";
import { logDebug, logInfo } from "../../core/observability/structured-log.js";
import type { AgentInterventionReq, AgentInterventionRes, InterventionEnvelope } from "../types.js";

interface PerSessionState {
  ring: InterventionEnvelope[];
  /** Resolvers waiting to drain. Each call to drain() returns at most one envelope. */
  waiters: Array<(env: InterventionEnvelope) => void>;
  /** True while at least one stream consumer is actively connected. */
  hasActiveStream: boolean;
}

const sessions = new Map<string, PerSessionState>();

function stateFor(sessionName: string): PerSessionState {
  let s = sessions.get(sessionName);
  if (!s) {
    s = { ring: [], waiters: [], hasActiveStream: false };
    sessions.set(sessionName, s);
  }
  return s;
}

function enqueue(sessionName: string, env: InterventionEnvelope): boolean {
  const s = stateFor(sessionName);
  // Hand directly to a waiter when one is parked, otherwise buffer.
  const waiter = s.waiters.shift();
  if (waiter) {
    waiter(env);
    return true;
  }
  s.ring.push(env);
  return false;
}

function dequeue(sessionName: string, signal: AbortSignal): Promise<InterventionEnvelope | null> {
  const s = stateFor(sessionName);
  const buffered = s.ring.shift();
  if (buffered) return Promise.resolve(buffered);
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<InterventionEnvelope | null>((resolve) => {
    const onAbort = () => {
      const idx = s.waiters.indexOf(deliver);
      if (idx >= 0) s.waiters.splice(idx, 1);
      resolve(null);
    };
    const deliver = (env: InterventionEnvelope) => {
      signal.removeEventListener("abort", onAbort);
      resolve(env);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    s.waiters.push(deliver);
  });
}

/**
 * Test-only helper: clear all per-session queues + waiters. Production code
 * never needs this -- queues are bounded by the agent's drain rate and a
 * session's state goes away naturally when the daemon exits.
 */
export function _resetForTests(): void {
  for (const s of sessions.values()) {
    s.ring.length = 0;
    for (const w of s.waiters) w({ content: "" }); // unblock; drain loop sees abort path
    s.waiters.length = 0;
    s.hasActiveStream = false;
  }
  sessions.clear();
}

function ndjsonLine(env: InterventionEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(env) + "\n");
}

export async function handleInterventionRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
  // ── Producer: conductor -> queue ───────────────────────────────────────
  if (req.method === "POST" && path === "/agent/intervention") {
    const url = new URL(req.url);
    const session = url.searchParams.get("session");
    if (!session || !SAFE_TMUX_NAME_RE.test(session)) {
      return json({ error: "missing or invalid `session` query param" }, 400);
    }
    let body: AgentInterventionReq;
    try {
      body = (await req.json()) as AgentInterventionReq;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.content !== "string" || body.content.length === 0) {
      return json({ error: "`content` must be a non-empty string" }, 400);
    }
    if (body.control !== undefined && body.control !== "interrupt") {
      return json({ error: "`control` must be omitted or 'interrupt'" }, 400);
    }
    const env: InterventionEnvelope = body.control
      ? { content: body.content, control: body.control }
      : { content: body.content };
    const delivered = enqueue(session, env);
    const res: AgentInterventionRes = { ok: true, delivered };
    return json(res);
  }

  // ── Consumer: agent long-poll stream ───────────────────────────────────
  if (req.method === "GET" && path === "/agent/interventions/stream") {
    const url = new URL(req.url);
    const session = url.searchParams.get("session");
    if (!session) return json({ error: "missing `session` query param" }, 400);
    try {
      requireSafeTmuxName(session);
    } catch {
      return json({ error: "invalid `session` query param" }, 400);
    }

    const state = stateFor(session);
    state.hasActiveStream = true;

    const ac = new AbortController();
    req.signal.addEventListener("abort", () => ac.abort());

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        logInfo("compute", `arkd interventions: stream opened for ${session}`);
        void (async () => {
          try {
            while (!ac.signal.aborted) {
              const env = await dequeue(session, ac.signal);
              if (!env) break;
              try {
                controller.enqueue(ndjsonLine(env));
              } catch {
                logDebug("compute", "interventions: enqueue threw, stream closed");
                ac.abort();
              }
            }
          } finally {
            state.hasActiveStream = false;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            logInfo("compute", `arkd interventions: stream closed for ${session}`);
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
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  return null;
}
