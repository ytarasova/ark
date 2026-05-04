/**
 * Generic channel pub/sub.
 *
 * Endpoints:
 *   - `POST /channel/{name}/publish` -- fire-and-forget producer.
 *   - `WS /ws/channel/{name}` -- persistent subscriber over WebSocket.
 *
 * arkd is the rendezvous for two directions of opaque-envelope traffic:
 *
 *   - `hooks` channel: agent -> conductor. Carries hook events,
 *     channel-report frames, and channel-relay frames. Each envelope carries
 *     its own `kind` so the conductor's `arkd-events-consumer` can dispatch.
 *
 *   - `user-input` channel: conductor -> agent. Carries `{ session, content,
 *     control? }` envelopes; the agent's user-message stream consumer
 *     filters by `envelope.session === ARK_SESSION_ID`.
 *
 * Why WebSocket for subscribers: previously this used HTTP/1.1 long-poll
 * (NDJSON over fetch+ReadableStream). That works in steady state but
 * silently breaks when traffic goes idle for >~5min: client fetch keep-
 * alive, server idle timers, and intermediate proxies (SSM tunnel) can
 * each tear the connection down independently of the application. A user
 * steer published in that gap sat in arkd's ring buffer with no parked
 * subscriber, delivered up to 5min late on the next reattach.
 *
 * WebSocket fixes this at the protocol level: Bun's WS server sends
 * automatic ping frames (`sendPings: true` is the default), the client
 * answers with pong, and every layer sees periodic traffic. No
 * application-level keepalive plumbing needed.
 *
 * Channels are GLOBAL (shared across all sessions on this arkd instance).
 * Subscribers see every envelope on the channel; per-session filtering is
 * the consumer's responsibility, carried in the envelope.
 *
 * Fan-out semantics: each envelope goes to the FIRST open subscriber in
 * insertion order. This is deliberate: `hooks` is single-reader (one
 * conductor per arkd) and `user-input` is read by exactly one agent. If a
 * future channel needs true broadcast, add a `broadcast: true` flag to the
 * subscribe handshake; the extension point is obvious.
 *
 * Subscribe handshake: the server sends `{ "type": "subscribed" }` as the
 * very first frame on every new WS connection, from inside the `open()`
 * handler -- after `s.subscribers.add(ws)` has run and the ring has been
 * drained. The client's `subscribeToChannel` returns a Promise that resolves
 * only after receiving this ack. Any publish that happens after the caller's
 * await is guaranteed to find a live subscriber. No Bun.sleep race fudges.
 *
 * Validation: channel names are restricted to `[A-Za-z0-9_-]{1,64}`.
 * Nested paths (`/channel/foo/bar/publish`) are rejected.
 */

import type { ServerWebSocket } from "bun";
import { json, type RouteCtx, SAFE_TMUX_NAME_RE } from "../internal.js";
import { logDebug, logInfo } from "../../core/observability/structured-log.js";

type Envelope = Record<string, unknown>;

/**
 * Control frame the server sends as the very first message on every new
 * subscriber WS. Pre-stringified at module load to avoid repeated
 * JSON.stringify on the hot path.
 *
 * The client's `webSocketToAsyncIterable` strips this frame before yielding
 * to callers; only envelope payloads are visible to consumers.
 */
export const SUBSCRIBED_ACK = JSON.stringify({ type: "subscribed" });

/** Per-WS-connection data attached via `server.upgrade(req, { data })`. */
export interface ChannelWsData {
  channel: string;
}

interface ChannelState {
  /** Buffered envelopes waiting for a subscriber. FIFO drained on next connect. */
  ring: Envelope[];
  /** Currently-open WS subscribers in connect order. */
  subscribers: Set<ServerWebSocket<ChannelWsData>>;
}

const channels = new Map<string, ChannelState>();

function stateFor(name: string): ChannelState {
  let s = channels.get(name);
  if (!s) {
    s = { ring: [], subscribers: new Set() };
    channels.set(name, s);
  }
  return s;
}

function enqueue(name: string, envelope: Envelope): boolean {
  const s = stateFor(name);
  // Fan-out to the first open subscriber. Iteration order = insertion order,
  // so the first-attached subscriber gets each envelope. If delivery throws
  // (socket half-closed mid-send), drop that subscriber and try the next.
  for (const ws of s.subscribers) {
    try {
      ws.send(JSON.stringify(envelope));
      return true;
    } catch {
      s.subscribers.delete(ws);
    }
  }
  // No live subscriber -- buffer for the next connect.
  s.ring.push(envelope);
  return false;
}

/**
 * Publish an envelope from inside arkd (e.g. legacy channel-report path).
 * Returns `true` when delivered to a live subscriber, `false` when buffered.
 */
export function publishOnChannel(name: string, envelope: Envelope): boolean {
  return enqueue(name, envelope);
}

/**
 * Bun WebSocket handler for `/ws/channel/{name}`. Wired into the
 * `Bun.serve({ websocket })` config in `server.ts`.
 *
 * Subscribe handshake
 * -------------------
 * `open`: add the WS to `s.subscribers`, drain the ring buffer in FIFO
 * order, then send `SUBSCRIBED_ACK` (`{ type: "subscribed" }`). The ack
 * arrives at the client only after all three steps complete -- giving the
 * client's `subscribeToChannel` a deterministic "I am parked" signal. Any
 * publish that races with the WS Upgrade response will either have been
 * buffered in the ring (drained before the ack) or will find a live
 * subscriber (delivered directly). Either way the ack arrives after the
 * server is in a consistent state.
 *
 * `message`: ignored. Publishers use `POST /channel/{name}/publish`.
 *
 * `close`: remove the WS from the subscriber set.
 *
 * Keep-alive
 * ----------
 * Bun's WS server sends ping frames automatically when `sendPings: true`
 * (configured in `server.ts`). The client WebSocket replies with pong,
 * keeping every TCP / proxy / SSM tunnel layer's idle timer alive without
 * any application-level heartbeat.
 */
export const channelWebSocketHandler = {
  open(ws: ServerWebSocket<ChannelWsData>): void {
    const { channel } = ws.data;
    const s = stateFor(channel);
    s.subscribers.add(ws);

    // Drain buffered envelopes before sending the ack so the client receives
    // them in the same contiguous burst, not after a gap.
    while (s.ring.length > 0) {
      const env = s.ring.shift()!;
      try {
        ws.send(JSON.stringify(env));
      } catch {
        // Socket closed during drain -- re-queue at the front for the next
        // subscriber and bail without sending the ack.
        s.subscribers.delete(ws);
        s.ring.unshift(env);
        return;
      }
    }

    // Send the ready ack LAST -- after the subscriber is registered and the
    // ring is empty. The client unblocks its subscribeToChannel Promise on
    // this frame.
    try {
      ws.send(SUBSCRIBED_ACK);
    } catch {
      s.subscribers.delete(ws);
      return;
    }

    logInfo("compute", `arkd channels: ws subscriber attached channel=${channel}`);
  },

  message(_ws: ServerWebSocket<ChannelWsData>, _msg: string | Buffer): void {
    // Subscribers do not push messages to the channel via WS; publishers use
    // POST /channel/{name}/publish. Ignore any incoming frames.
    logDebug("compute", "arkd channels: ws subscriber sent unexpected message; ignoring");
  },

  close(ws: ServerWebSocket<ChannelWsData>): void {
    const { channel } = ws.data;
    const s = channels.get(channel);
    if (s) s.subscribers.delete(ws);
    logInfo("compute", `arkd channels: ws subscriber detached channel=${channel}`);
  },
};

/**
 * Test-only: close all open subscriber WS connections and clear every
 * channel's ring buffer. Called in `afterEach` to prevent connection and
 * state leaks between test cases.
 */
export function _resetForTests(): void {
  for (const s of channels.values()) {
    s.ring.length = 0;
    for (const ws of s.subscribers) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    s.subscribers.clear();
  }
  channels.clear();
}

function matchPublishPath(path: string): string | null {
  const prefix = "/channel/";
  const suffix = "/publish";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const inner = path.slice(prefix.length, path.length - suffix.length);
  if (inner.length === 0) return null;
  if (!SAFE_TMUX_NAME_RE.test(inner)) return null;
  return inner;
}

export function matchWsChannelPath(path: string): string | null {
  const prefix = "/ws/channel/";
  if (!path.startsWith(prefix)) return null;
  const inner = path.slice(prefix.length);
  if (inner.length === 0) return null;
  if (!SAFE_TMUX_NAME_RE.test(inner)) return null;
  return inner;
}

export async function handleChannelRoutes(req: Request, path: string, _ctx: RouteCtx): Promise<Response | null> {
  // ── Producer: POST /channel/{name}/publish ──────────────────────────────
  if (req.method === "POST" && path.startsWith("/channel/") && path.endsWith("/publish")) {
    const name = matchPublishPath(path);
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

  // WS subscribe is handled in server.ts via Bun's native upgrade path;
  // channel-level routing uses matchWsChannelPath above.
  return null;
}
