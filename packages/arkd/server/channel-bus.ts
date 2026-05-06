/**
 * Generic channel pub/sub -- the bus primitive.
 *
 * Endpoints (wired in server.ts):
 *   - `POST /channel/{name}/publish` -- fire-and-forget producer (HTTP wrapper in routes/channels.ts).
 *   - `WS /ws/channel/{name}` -- persistent subscriber over WebSocket.
 *
 * arkd is the rendezvous for two directions of opaque-envelope traffic:
 *
 *   - `hooks` channel: agent -> conductor. Carries hook events,
 *     channel-report frames, and channel-relay frames. Each envelope carries
 *     its own `kind` so the conductor's `arkd-events-consumer` can dispatch.
 *     SINGLE-READER: there is exactly one conductor per arkd, so each
 *     envelope is delivered to exactly one subscriber (the conductor).
 *     Multiple readers would double-process every event.
 *
 *   - `user-input` channel: conductor -> agent. Carries `{ session, content,
 *     control? }` envelopes; the agent's user-message stream consumer
 *     filters by `envelope.session === ARK_SESSION_ID`.
 *     BROADCAST: the channel is global (one wire, many sessions); each
 *     subscriber filters by its own session id. Broadcasting means a
 *     stale-but-readyState=OPEN subscriber from a dead session can't
 *     silently absorb the only copy of an envelope intended for the live
 *     subscriber of the new session.
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
 * Delivery semantics are per-channel:
 *   - `user-input`: BROADCAST -- each subscriber filters by session id, so
 *     every open subscriber gets a copy. Stale subscribers (dead sessions)
 *     ignore non-matching envelopes; the live one consumes its own.
 *   - everything else (including `hooks`): FAN-OUT-TO-FIRST -- the
 *     envelope goes to the first OPEN subscriber in insertion order. Used
 *     when there is exactly one logical reader (the conductor for hooks);
 *     broadcasting would deliver each envelope to N readers and double-
 *     process every event.
 *
 * Both modes evict zombies (readyState !== OPEN, or send returns <= 0) in
 * the same pass that delivers, so a half-closed socket doesn't keep
 * absorbing envelopes silently.
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
import { SAFE_TMUX_NAME_RE, SUBSCRIBED_ACK } from "../common/constants.js";
import { logDebug, logInfo } from "../../core/observability/structured-log.js";

export type Envelope = Record<string, unknown>;

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

/**
 * Channels with broadcast delivery semantics. Other channels fan out to
 * the first open subscriber. See the file header for the per-channel
 * rationale -- the short version: broadcast is for channels where every
 * subscriber filters by some discriminator (e.g. session id) and we don't
 * want stale subscribers to silently absorb the only copy of an envelope.
 */
const BROADCAST_CHANNELS = new Set(["user-input"]);

function enqueue(name: string, envelope: Envelope): boolean {
  const s = stateFor(name);
  const payload = JSON.stringify(envelope);
  const broadcast = BROADCAST_CHANNELS.has(name);

  // Walk subscribers, evicting zombies (readyState !== OPEN, or send
  // returns 0 which Bun uses to signal "socket closed/closing"). Bun's
  // ws.send() does NOT throw on a half-closed socket -- it returns the
  // byte count, with <=0 meaning the frame was not delivered. The
  // previous try/catch pattern silently dropped envelopes in that case.
  const dead: Array<ServerWebSocket<ChannelWsData>> = [];
  let deliveredAny = false;
  for (const ws of s.subscribers) {
    if (ws.readyState !== 1 /* OPEN */) {
      dead.push(ws);
      continue;
    }
    const written = ws.send(payload);
    if (written > 0) {
      deliveredAny = true;
      // Fan-out: stop at the first successful delivery. Broadcast: keep
      // going so every live subscriber receives a copy.
      if (!broadcast) break;
    } else {
      dead.push(ws);
    }
  }
  for (const ws of dead) s.subscribers.delete(ws);
  if (deliveredAny) return true;
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
 * Publish an envelope from the HTTP wrapper (`POST /channel/{name}/publish`).
 * Thin alias for `enqueue` that keeps the internal helper module-private.
 * Returns `true` when delivered to a live subscriber, `false` when buffered.
 */
export function publishFromHttp(name: string, envelope: Envelope): boolean {
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
 * Returns the channel name if `path` matches `/ws/channel/{name}` with a
 * valid channel name, or null otherwise. Used in server.ts to decide whether
 * to upgrade the request to a WebSocket.
 */
export function matchWsChannelPath(path: string): string | null {
  const prefix = "/ws/channel/";
  if (!path.startsWith(prefix)) return null;
  const inner = path.slice(prefix.length);
  if (inner.length === 0) return null;
  if (!SAFE_TMUX_NAME_RE.test(inner)) return null;
  return inner;
}

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
