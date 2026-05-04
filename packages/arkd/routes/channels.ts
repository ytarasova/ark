/**
 * Generic channel pub/sub: `POST /channel/{name}/publish` + `GET /channel/{name}/subscribe`.
 *
 * arkd is the rendezvous for two directions of opaque-envelope traffic that
 * previously lived on hard-coded routes:
 *
 *   - `hooks` channel: agent -> conductor. Carries hook events,
 *     channel-report frames (agent -> conductor session reports), and
 *     channel-relay frames (agent -> agent messages). Each envelope carries
 *     its own `kind` so the conductor's `arkd-events-consumer` can dispatch.
 *
 *   - `user-input` channel: conductor -> agent. Carries `{ session, content,
 *     control? }` envelopes; the agent's user-message stream consumer
 *     filters by `envelope.session === ARK_SESSION_ID`.
 *
 * Channels are GLOBAL (shared across all sessions on this arkd instance).
 * Subscribers see every envelope on the channel; per-session filtering is
 * the consumer's responsibility, carried in the envelope. This keeps the
 * primitive minimal -- arkd does not parse envelope contents.
 *
 * Storage shape: per-channel-name in-memory queue + parked-waiter list. When
 * an envelope arrives:
 *   - If a subscriber is currently parked, hand the envelope directly
 *     (`delivered: true`).
 *   - Otherwise buffer it on the channel's ring; the next subscriber drains
 *     it on connect (`delivered: false`).
 *
 * Multi-subscriber on the same channel is fan-OUT in waiter order: each
 * envelope goes to the first parked waiter. This matches the legacy
 * user-messages route's semantics; the hooks-channel consumer is
 * effectively single-reader (one conductor per arkd).
 *
 * Validation: channel names are restricted to the same safe-name pattern as
 * tmux session names (`[A-Za-z0-9_-]{1,64}`), so the path segment never
 * contains `/`, spaces, or shell metacharacters. Nested paths
 * (`/channel/foo/bar/publish`) are rejected; the route handler matches
 * exactly one segment between `/channel/` and `/publish` or `/subscribe`.
 */

import { json, type RouteCtx, SAFE_TMUX_NAME_RE } from "../internal.js";
import { logDebug, logInfo } from "../../core/observability/structured-log.js";

type Envelope = Record<string, unknown>;

interface ChannelState {
  /** Buffered envelopes waiting for a subscriber. FIFO drained on connect. */
  ring: Envelope[];
  /**
   * Parked subscribers. When `publish` arrives and the ring is empty, the
   * first waiter is shifted off and given the envelope directly. Each call
   * to `dequeue` parks at most one waiter per subscriber-loop iteration.
   */
  waiters: Array<(env: Envelope) => void>;
}

const channels = new Map<string, ChannelState>();

function stateFor(name: string): ChannelState {
  let s = channels.get(name);
  if (!s) {
    s = { ring: [], waiters: [] };
    channels.set(name, s);
  }
  return s;
}

function enqueue(name: string, envelope: Envelope): boolean {
  const s = stateFor(name);
  // Hand directly to a waiter when one is parked, otherwise buffer.
  const waiter = s.waiters.shift();
  if (waiter) {
    waiter(envelope);
    return true;
  }
  s.ring.push(envelope);
  return false;
}

function dequeue(name: string, signal: AbortSignal): Promise<Envelope | null> {
  const s = stateFor(name);
  const buffered = s.ring.shift();
  if (buffered) return Promise.resolve(buffered);
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<Envelope | null>((resolve) => {
    const onAbort = (): void => {
      const idx = s.waiters.indexOf(deliver);
      if (idx >= 0) s.waiters.splice(idx, 1);
      resolve(null);
    };
    const deliver = (env: Envelope): void => {
      signal.removeEventListener("abort", onAbort);
      resolve(env);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    s.waiters.push(deliver);
  });
}

/**
 * Internal helper: enqueue an envelope on a channel from inside arkd
 * (e.g. the legacy /channel/<sid> report path forwards through here).
 * Returns `true` when handed directly to a parked subscriber, `false`
 * when buffered. Production callers usually ignore the return value;
 * the buffered case is still durable until the next subscriber drains.
 */
export function publishOnChannel(name: string, envelope: Envelope): boolean {
  return enqueue(name, envelope);
}

/**
 * Test-only helper: clear all per-channel queues + waiters. Production code
 * never needs this -- channel state goes away naturally when arkd exits.
 */
export function _resetForTests(): void {
  for (const s of channels.values()) {
    s.ring.length = 0;
    // Unblock any parked waiter so its loop can observe the abort path.
    for (const w of s.waiters) w({});
    s.waiters.length = 0;
  }
  channels.clear();
}

function ndjsonLine(envelope: Envelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope) + "\n");
}

/**
 * Match `/channel/<name>/<verb>` exactly. Returns the channel name when the
 * path matches and the name is safe; null otherwise. Rejects nested paths
 * (anything with more than three `/`-separated segments after the leading
 * `/channel/`).
 */
function matchChannelPath(path: string, verb: "publish" | "subscribe"): string | null {
  const prefix = "/channel/";
  const suffix = `/${verb}`;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const inner = path.slice(prefix.length, path.length - suffix.length);
  if (inner.length === 0) return null;
  // Reject nested paths: a single safe-name segment only.
  if (!SAFE_TMUX_NAME_RE.test(inner)) return null;
  return inner;
}

export async function handleChannelRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
  // ── Producer: POST /channel/{name}/publish ──────────────────────────────
  if (req.method === "POST" && path.startsWith("/channel/") && path.endsWith("/publish")) {
    const name = matchChannelPath(path, "publish");
    if (!name) {
      return json({ error: "invalid channel name: must match [A-Za-z0-9_-]{1,64}" }, 400);
    }
    let body: { envelope?: unknown };
    try {
      body = (await req.json()) as { envelope?: unknown };
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    const env = body?.envelope;
    if (env === undefined || env === null || typeof env !== "object" || Array.isArray(env)) {
      return json({ error: "`envelope` must be a JSON object" }, 400);
    }
    const delivered = enqueue(name, env as Envelope);
    return json({ ok: true, delivered });
  }

  // ── Consumer: GET /channel/{name}/subscribe ─────────────────────────────
  if (req.method === "GET" && path.startsWith("/channel/") && path.endsWith("/subscribe")) {
    const name = matchChannelPath(path, "subscribe");
    if (!name) {
      return json({ error: "invalid channel name: must match [A-Za-z0-9_-]{1,64}" }, 400);
    }

    const ac = new AbortController();
    req.signal.addEventListener("abort", () => ac.abort());

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        logInfo("compute", `arkd channels: subscriber attached channel=${name}`);
        // Keepalive: emit a benign frame every 30s so HTTP/1.1 idle
        // timers (Bun runtime, intermediate proxies, the SSM tunnel)
        // see the connection as live and don't tear it down. The frame
        // is `{}` -- consumers (subscribeUserMessages, the conductor's
        // arkd-events-consumer) treat envelopes without their expected
        // fields as no-ops and discard them. Without this, mid-session
        // user steers landed in arkd's ring buffer with no parked
        // subscriber to receive them, then waited up to 5 minutes for
        // the next reconnect.
        const KEEPALIVE_INTERVAL_MS = 30_000;
        const keepalive = setInterval(() => {
          if (ac.signal.aborted) return;
          try {
            controller.enqueue(ndjsonLine({} as Envelope));
          } catch {
            /* stream closed */
          }
        }, KEEPALIVE_INTERVAL_MS);
        keepalive.unref?.();
        void (async () => {
          try {
            while (!ac.signal.aborted) {
              const env = await dequeue(name, ac.signal);
              if (!env) break;
              try {
                controller.enqueue(ndjsonLine(env));
              } catch {
                logDebug("compute", `channels: enqueue threw, stream closed channel=${name}`);
                ac.abort();
              }
            }
          } finally {
            clearInterval(keepalive);
            try {
              controller.close();
            } catch {
              /* already closed */
            }
            logInfo("compute", `arkd channels: subscriber detached channel=${name}`);
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
        // Prevent any intermediate proxy from buffering chunks.
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      },
    });
  }

  return null;
}
