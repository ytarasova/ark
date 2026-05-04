/**
 * /channel/{name}/publish + /ws/channel/{name} tests.
 *
 * Drives a live arkd to verify the generic pub/sub primitive over
 * WebSocket subscribers:
 *   - publish-before-subscribe buffers; subscriber drains FIFO on connect
 *   - publish-after-subscribe hands directly to the parked waiter
 *   - per-channel isolation
 *   - validation (channel name, envelope shape, JSON body)
 *   - clean teardown when the subscriber closes the WS
 *   - opaque envelopes (arkd does not parse, deeply-nested JSON round-trips)
 *   - auth: token in Sec-WebSocket-Protocol accepted; missing token rejected
 *   - ArkdClient.subscribeToChannel end-to-end
 *   - keep-alive: connection survives an idle period spanning the ping cycle
 *
 * Test strategy: every test that needs a "parked subscriber" waits for the
 * server's `{ type: "subscribed" }` ack via `subscribedChannel()`. The ack
 * is emitted from inside the server's `open()` handler, after
 * `s.subscribers.add(ws)` has run, so any publish that happens after the
 * await is guaranteed to find a live subscriber. No Bun.sleep race fudges.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startArkd } from "../server.js";
import { _resetForTests } from "../routes/channels.js";
import { ArkdClient } from "../client.js";
import { allocatePort } from "../../core/config/port-allocator.js";

let server: { stop(): void };
let port: number;
let baseUrl: string;
let wsBase: string;

beforeAll(async () => {
  port = await allocatePort();
  server = startArkd(port, { quiet: true });
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

afterAll(() => {
  server.stop();
});

afterEach(() => {
  _resetForTests();
});

// ── Test helpers ───────────────────────────────────────────────────────────

/**
 * Open a WS to the given channel and wait for the server's
 * `{ type: "subscribed" }` ack before resolving. The ack is sent from
 * inside the server's `open()` handler, after the subscriber is registered
 * AND after the ring buffer is drained -- so any pre-buffered envelopes
 * arrive at the client BEFORE the ack. The helper installs a single
 * message listener that buffers envelope frames into a queue and resolves
 * the ack promise on the control frame, ensuring no buffered envelope is
 * lost between ack-wait and `nextMessages()`.
 *
 * Returns:
 *   - `ws`: the open WebSocket (already acked)
 *   - `nextMessages(n)`: Promise that resolves with the next `n` envelope
 *     frames (skipping control frames) or rejects on timeout. Includes any
 *     envelopes that arrived before the ack.
 */
async function subscribedChannel(
  channel: string,
  timeoutMs = 2000,
): Promise<{ ws: WebSocket; nextMessages(n: number): Promise<unknown[]> }> {
  const ws = new WebSocket(`${wsBase}/ws/channel/${encodeURIComponent(channel)}`);

  // Queue of envelope frames received so far. The single message listener
  // pushes here; `nextMessages` drains this first before parking on a waker.
  const buffered: unknown[] = [];
  let waker: (() => void) | null = null;
  const wake = (): void => {
    const w = waker;
    waker = null;
    if (w) w();
  };

  let ackResolve!: () => void;
  let ackReject!: (err: Error) => void;
  const ackPromise = new Promise<void>((resolve, reject) => {
    ackResolve = resolve;
    ackReject = reject;
  });

  ws.addEventListener("message", (ev) => {
    try {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
      if (frame.type === "subscribed") {
        ackResolve();
        return;
      }
      if (typeof frame.type === "string") return; // skip other control frames
      buffered.push(frame);
      wake();
    } catch {
      /* ignore malformed */
    }
  });
  ws.addEventListener("error", () => ackReject(new Error("ws error before subscribed ack")), { once: true });
  ws.addEventListener("close", () => {
    ackReject(new Error("ws closed before subscribed ack"));
    wake();
  });

  await Promise.race([
    ackPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("subscribed ack timeout")), timeoutMs)),
  ]);

  function nextMessages(n: number): Promise<unknown[]> {
    return new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`nextMessages(${n}) timeout after ${timeoutMs}ms`)), timeoutMs);
      const tryDrain = (): void => {
        if (buffered.length >= n) {
          clearTimeout(timer);
          resolve(buffered.splice(0, n));
          return;
        }
        waker = tryDrain;
      };
      tryDrain();
    });
  }

  return { ws, nextMessages };
}

/**
 * Subscribe, wait for exactly `max` buffered messages, close, return.
 * For tests that publish before subscribing (buffer-drain scenario).
 */
async function collect(channel: string, max: number, timeoutMs = 2000): Promise<unknown[]> {
  const { ws, nextMessages } = await subscribedChannel(channel, timeoutMs);
  try {
    return await nextMessages(max);
  } finally {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}

async function publish(channel: string, envelope: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/channel/${encodeURIComponent(channel)}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envelope }),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("/channel/{name}/publish + /ws/channel/{name}", () => {
  test("buffers envelopes until a subscriber connects, then drains FIFO", async () => {
    const r1 = await publish("hooks", { kind: "hook", session: "s-1", body: { event: "first" } });
    expect(r1.ok).toBe(true);
    expect(((await r1.json()) as { delivered: boolean }).delivered).toBe(false);

    const r2 = await publish("hooks", { kind: "hook", session: "s-1", body: { event: "second" } });
    expect(r2.ok).toBe(true);
    expect(((await r2.json()) as { delivered: boolean }).delivered).toBe(false);

    const lines = (await collect("hooks", 2)) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect((lines[0].body as { event: string }).event).toBe("first");
    expect((lines[1].body as { event: string }).event).toBe("second");
  });

  test("hands directly to a parked subscriber (delivered=true)", async () => {
    // subscribedChannel resolves after the server's ack -- which is sent from
    // inside open(), after s.subscribers.add(ws). No sleep needed.
    const { ws, nextMessages } = await subscribedChannel("user-input");

    const r = await publish("user-input", { session: "s-x", content: "hello" });
    expect(((await r.json()) as { delivered: boolean }).delivered).toBe(true);

    const [env] = (await nextMessages(1)) as Array<Record<string, unknown>>;
    expect(env).toEqual({ session: "s-x", content: "hello" });
    ws.close();
  });

  test("multi-channel isolation: publish to A does not appear on B", async () => {
    await publish("a-channel", { tag: "for A" });
    await publish("b-channel", { tag: "for B" });

    const linesB = (await collect("b-channel", 1)) as Array<Record<string, unknown>>;
    expect(linesB).toEqual([{ tag: "for B" }]);

    const linesA = (await collect("a-channel", 1)) as Array<Record<string, unknown>>;
    expect(linesA).toEqual([{ tag: "for A" }]);
  });

  test("rejects channel names with spaces or slashes (publish)", async () => {
    const r1 = await fetch(`${baseUrl}/channel/${encodeURIComponent("has spaces")}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: { ok: 1 } }),
    });
    expect(r1.status).toBe(400);

    const r2 = await fetch(`${baseUrl}/channel/foo/bar/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: { ok: 1 } }),
    });
    expect(r2.status).toBe(400);
  });

  test("rejects WS subscribe to invalid channel names", async () => {
    const ws = new WebSocket(`${wsBase}/ws/channel/${encodeURIComponent("has spaces")}`);
    const result = await Promise.race([
      new Promise<"open">((resolve) => ws.addEventListener("open", () => resolve("open"), { once: true })),
      new Promise<"closed">((resolve) => ws.addEventListener("close", () => resolve("closed"), { once: true })),
      new Promise<"error">((resolve) => ws.addEventListener("error", () => resolve("error"), { once: true })),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    expect(["closed", "error"]).toContain(result);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });

  test("rejects publish with missing or invalid envelope", async () => {
    const r1 = await fetch(`${baseUrl}/channel/c1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r1.status).toBe(400);

    const r2 = await fetch(`${baseUrl}/channel/c1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: "not-an-object" }),
    });
    expect(r2.status).toBe(400);

    const r3 = await fetch(`${baseUrl}/channel/c1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: [1, 2, 3] }),
    });
    expect(r3.status).toBe(400);
  });

  test("rejects publish with invalid JSON body", async () => {
    const r = await fetch(`${baseUrl}/channel/c1/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });

  test("subscriber close cleanly removes the WS so the next publish buffers", async () => {
    const { ws } = await subscribedChannel("c-close");
    ws.close();

    // Poll until the server's close() handler has run and removed the
    // subscriber. Typically <5ms; capped at 2s for slow CI. We retry rather
    // than sleeping a fixed duration so the test is as fast as the server.
    const deadline = Date.now() + 2000;
    let delivered = true;
    while (delivered && Date.now() < deadline) {
      const r = await publish("c-close", { ok: 1 });
      const body = (await r.json()) as { delivered: boolean };
      delivered = body.delivered;
      if (delivered) {
        // Drain the buffered envelope so it doesn't affect the next attempt.
        _resetForTests();
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(delivered).toBe(false);
  });

  test("envelope is opaque: arbitrary nested objects round-trip unchanged", async () => {
    const env = {
      kind: "hook",
      session: "s-deep",
      meta: {
        nested: {
          arr: [1, "two", { three: true }],
          n: null,
          b: false,
        },
      },
      ts: "2026-05-02T00:00:00.000Z",
    };
    await publish("opaque", env);
    const lines = (await collect("opaque", 1)) as Array<Record<string, unknown>>;
    expect(lines[0]).toEqual(env);
  });

  test("auth: Bearer token in Sec-WebSocket-Protocol is accepted for WS upgrade", async () => {
    const authPort = await allocatePort();
    const authServer = startArkd(authPort, { quiet: true, token: "test-secret" });
    const authWsBase = `ws://127.0.0.1:${authPort}`;
    const authHttpBase = `http://127.0.0.1:${authPort}`;
    try {
      // Valid token via Sec-WebSocket-Protocol: should receive the ack.
      const ws = new WebSocket(`${authWsBase}/ws/channel/auth-ch`, ["Bearer.test-secret"]);
      const ackResult = await Promise.race([
        new Promise<"subscribed">((resolve) => {
          ws.addEventListener("message", (ev) => {
            try {
              const frame = JSON.parse(String(ev.data)) as Record<string, unknown>;
              if (frame.type === "subscribed") resolve("subscribed");
            } catch {
              /* skip */
            }
          });
        }),
        new Promise<"error">((resolve) => ws.addEventListener("error", () => resolve("error"), { once: true })),
        new Promise<"close">((resolve) => ws.addEventListener("close", () => resolve("close"), { once: true })),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 2000)),
      ]);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      expect(ackResult).toBe("subscribed");

      // No-token HTTP publish returns 401.
      const badResp = await fetch(`${authHttpBase}/channel/auth-ch/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ envelope: { x: 1 } }),
      });
      expect(badResp.status).toBe(401);

      // No-token WS upgrade is rejected (close or error before open).
      const wsNoAuth = new WebSocket(`${authWsBase}/ws/channel/auth-ch`);
      const noAuthResult = await Promise.race([
        new Promise<"open">((resolve) => wsNoAuth.addEventListener("open", () => resolve("open"), { once: true })),
        new Promise<"closed">((resolve) => wsNoAuth.addEventListener("close", () => resolve("closed"), { once: true })),
        new Promise<"error">((resolve) => wsNoAuth.addEventListener("error", () => resolve("error"), { once: true })),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ]);
      try {
        wsNoAuth.close();
      } catch {
        /* ignore */
      }
      expect(["closed", "error"]).toContain(noAuthResult);
    } finally {
      authServer.stop();
    }
  });

  test("ArkdClient.subscribeToChannel delivers buffered then live envelopes", async () => {
    const client = new ArkdClient(baseUrl);

    // Publish before subscribing -- the iterable should drain the buffer.
    await publish("client-e2e", { msg: "buffered" });

    const iterable = await client.subscribeToChannel<{ msg: string }>("client-e2e");
    const iter = iterable[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value.msg).toBe("buffered");

    // Publish while subscribed -- should be delivered directly.
    const liveResp = await publish("client-e2e", { msg: "live" });
    expect(((await liveResp.json()) as { delivered: boolean }).delivered).toBe(true);

    const second = await iter.next();
    expect(second.done).toBe(false);
    expect(second.value.msg).toBe("live");

    await iter.return!();
  });

  test("keep-alive: WS connection survives idle period spanning the ping cycle", async () => {
    // Verifies that Bun's automatic ping frames (idleTimeout: 30, sendPings:
    // true in server.ts) keep the connection alive through a quiet period.
    // The 35s wait is the point of the test -- without protocol-level
    // pings the connection would close on the 30s idle timer and the
    // post-wait publish would buffer instead of being delivered.
    const { ws, nextMessages } = await subscribedChannel("keepalive-ch", 5000);
    await new Promise<void>((resolve) => setTimeout(resolve, 35_000));

    // Connection must still be alive: publish should be delivered directly.
    const r = await publish("keepalive-ch", { probe: true });
    expect(((await r.json()) as { delivered: boolean }).delivered).toBe(true);

    const [env] = (await nextMessages(1)) as Array<Record<string, unknown>>;
    expect(env).toEqual({ probe: true });
    ws.close();
  }, 45_000);
});
