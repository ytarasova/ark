/**
 * Conductor-side coverage for the SSM channel-report fix.
 *
 * The arkd events consumer (`packages/core/conductor/arkd-events-consumer.ts`)
 * pulls NDJSON frames from arkd's `/events/stream` long-poll. After the SSM
 * fix the stream carries `channel-report` and `channel-relay` frames in
 * addition to the existing `hook` frames; the consumer must dispatch them
 * through `handleReport` / the relay path so the conductor side-effects
 * (session updates, log events, message persistence, etc.) actually run.
 *
 * This test stubs out a minimal arkd-like server that streams a single
 * `channel-report` frame, starts the consumer pointed at that stub, and
 * verifies an `agent_progress` event was logged on the target session
 * exactly the way the legacy direct HTTP path used to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../app.js";
import {
  startArkdEventsConsumer,
  stopArkdEventsConsumer,
  _resetArkdEventsConsumers,
} from "../conductor/arkd-events-consumer.js";
import { allocatePort } from "../config/port-allocator.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  _resetArkdEventsConsumers();
  await app?.shutdown();
});

/**
 * Spin up a minimal HTTP server that mimics arkd's `/events/stream` shape:
 * for each incoming GET it streams the queued NDJSON lines exactly once
 * and then closes the response body. The consumer reconnects in a loop;
 * we only need one delivery to assert the dispatch path ran.
 */
function startStubArkd(port: number, lines: string[]): { stop(): void } {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/events/stream") {
        return new Response("not found", { status: 404 });
      }
      const enc = new TextEncoder();
      // Deliver each line then close. The consumer reads the lines, then the
      // socket closes naturally and the consumer parks in its reconnect
      // backoff -- which is fine because the test has already observed the
      // side-effect by then.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const line of lines) {
            controller.enqueue(enc.encode(line.endsWith("\n") ? line : line + "\n"));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
      });
    },
  });
}

async function waitForEvent(appCtx: AppContext, sessionId: string, type: string, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await appCtx.events.list(sessionId);
    const hit = events.find((e: { type: string }) => e.type === type);
    if (hit) return hit;
    await Bun.sleep(25);
  }
  return null;
}

describe("arkd-events-consumer: channel-report dispatch", () => {
  test("a channel-report frame on the stream runs handleReport on conductor", async () => {
    const session = await app.sessions.create({ summary: "consumer channel-report test", flow: "bare" });
    await app.sessions.update(session.id, { stage: "implement", status: "running" });

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

      // handleReport logs `agent_<type>` events via app.events.log -- this is
      // the same observation point the live HTTP path produces. If the frame
      // were silently dropped (the bug we just fixed), no event would land.
      const evt = (await waitForEvent(app, session.id, "agent_progress", 3000)) as {
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
    await app.sessions.update(session.id, { stage: "implement", status: "running" });

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

      const evt = (await waitForEvent(app, session.id, "agent_error", 3000)) as { data?: { error?: string } } | null;
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
      // Just give the consumer enough time to drain & log-and-ignore. If it
      // were going to throw, the test would surface that as an unhandled
      // rejection. We don't have a stronger observable here because by
      // design unknown frames are silently dropped.
      await Bun.sleep(150);
    } finally {
      stopArkdEventsConsumer("stub-compute-3");
      stub.stop();
    }
  });
});
