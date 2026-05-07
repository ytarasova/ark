/**
 * Conductor-side coverage for the SSM channel-report fix.
 *
 * The arkd events consumer (`packages/core/conductor/arkd-events-consumer.ts`)
 * subscribes to arkd's `hooks` channel via WebSocket (`/ws/channel/hooks`).
 * The channel carries `channel-report` and `channel-relay` envelopes in
 * addition to hook envelopes; the consumer must dispatch them through
 * `handleReport` / the relay path so the conductor side-effects (session
 * updates, log events, message persistence) actually run.
 *
 * This test stubs out a minimal WS-capable server that:
 *   1. Accepts the WS upgrade on `/ws/channel/hooks`.
 *   2. Sends `SUBSCRIBED_ACK` immediately in `open()` so that
 *      `ArkdClient.subscribeToChannel` resolves its ready Promise.
 *   3. Sends the queued frames immediately after the ack.
 *   4. Stays open until the test tears down.
 *
 * The consumer reconnects in a loop; we only need one delivery per test
 * to assert that the dispatch path ran.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { AppContext } from "../app.js";
import {
  startArkdEventsConsumer,
  stopArkdEventsConsumer,
  _resetArkdEventsConsumers,
} from "../services/channel/arkd-events-consumer.js";
import { allocatePort } from "../config/port-allocator.js";
import { SUBSCRIBED_ACK } from "../../arkd/common/index.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  _resetArkdEventsConsumers();
  await app?.shutdown();
});

interface StubWsData {
  frames: string[];
}

/**
 * Spin up a minimal Bun WS server that mimics arkd's `/ws/channel/hooks`
 * subscribe protocol:
 *   - Sends `SUBSCRIBED_ACK` on `open` so ArkdClient.subscribeToChannel
 *     resolves its ready promise.
 *   - Immediately follows with the pre-loaded frames.
 *   - Stays open (the consumer's reconnect loop will stay parked).
 */
function startStubArkd(port: number, frames: string[]): { stop(): void } {
  return Bun.serve<StubWsData>({
    port,
    hostname: "127.0.0.1",
    websocket: {
      open(ws: ServerWebSocket<StubWsData>): void {
        ws.send(SUBSCRIBED_ACK);
        for (const frame of ws.data.frames) {
          ws.send(frame);
        }
      },
      message(): void {
        /* stub ignores incoming messages */
      },
      close(): void {
        /* stub ignores close events */
      },
    },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws/channel/hooks") {
        if (srv.upgrade(req, { data: { frames } })) {
          return undefined as unknown as Response;
        }
        return new Response("upgrade failed", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

/**
 * Poll `app.events.list(sessionId)` until an event with the given type
 * appears or the deadline passes. Returns the event or null.
 */
async function waitForEvent(appCtx: AppContext, sessionId: string, type: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await appCtx.events.list(sessionId);
    const hit = events.find((e: { type: string }) => e.type === type);
    if (hit) return hit;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describe("arkd-events-consumer: channel-report dispatch", () => {
  test("a channel-report frame on the stream runs handleReport on conductor", async () => {
    const session = await app.sessions.create({ summary: "consumer channel-report test", flow: "bare" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, stage: "implement", status: "running" });

    const stubPort = await allocatePort();
    const frame = JSON.stringify({
      kind: "channel-report",
      session: session.id,
      tenantId: null,
      body: {
        type: "progress",
        sessionId: session.id,
        stage: "implement",
        message: "halfway through",
      },
      ts: new Date().toISOString(),
    });

    const stub = startStubArkd(stubPort, [frame]);
    try {
      startArkdEventsConsumer(app, "stub-compute-1", `http://127.0.0.1:${stubPort}`, null);

      const evt = (await waitForEvent(app, session.id, "agent_progress", 5000)) as {
        data?: { message?: string };
      } | null;
      expect(evt).not.toBeNull();
      expect(evt!.data?.message).toBe("halfway through");
    } finally {
      stopArkdEventsConsumer("stub-compute-1");
      stub.stop();
    }
  });

  test("a channel-report with type=error advances the session through handleReport", async () => {
    const session = await app.sessions.create({ summary: "consumer error report test", flow: "bare" });
    await app.sessions.update(session.id, { session_id: `ark-s-${session.id}`, stage: "implement", status: "running" });

    const stubPort = await allocatePort();
    const frame = JSON.stringify({
      kind: "channel-report",
      session: session.id,
      tenantId: null,
      body: {
        type: "error",
        sessionId: session.id,
        stage: "implement",
        error: "synthetic failure",
      },
      ts: new Date().toISOString(),
    });

    const stub = startStubArkd(stubPort, [frame]);
    try {
      startArkdEventsConsumer(app, "stub-compute-2", `http://127.0.0.1:${stubPort}`, null);

      const evt = (await waitForEvent(app, session.id, "agent_error", 5000)) as { data?: { error?: string } } | null;
      expect(evt).not.toBeNull();
      expect(evt!.data?.error).toBe("synthetic failure");
    } finally {
      stopArkdEventsConsumer("stub-compute-2");
      stub.stop();
    }
  });

  test("unknown frame kinds are ignored without throwing", async () => {
    const stubPort = await allocatePort();
    const frame = JSON.stringify({ kind: "future-thing", whatever: 1, ts: new Date().toISOString() });
    const stub = startStubArkd(stubPort, [frame]);
    try {
      startArkdEventsConsumer(app, "stub-compute-3", `http://127.0.0.1:${stubPort}`, null);
      // Wait long enough for the consumer to connect, receive the frame, and
      // log-and-ignore. An unhandled rejection would fail the test process.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    } finally {
      stopArkdEventsConsumer("stub-compute-3");
      stub.stop();
    }
  });
});
