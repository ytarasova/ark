/**
 * Tests for channel/deliver and channel/relay JSON-RPC handlers.
 *
 * channel/deliver routes an agent report through the shared report pipeline
 * (`handleReport`). We assert the observable side-effects: events logged and
 * messages stored via `app.events.list` / `app.messages.list`.
 *
 * channel/relay routes a steer payload to a target session's channel port.
 * The channel won't be listening in the test environment so deliverToChannel
 * silently swallows the send -- we assert the happy path returns `{ok: true}`
 * and that an unknown session returns SESSION_NOT_FOUND.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerChannelHandlers } from "../handlers/channel.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../protocol/types.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

beforeEach(() => {
  router = new Router();
  registerChannelHandlers(router, app);
});

/** Create a session and return its id. */
async function createSession(summary = "ch-test"): Promise<string> {
  const s = await app.sessions.create({ summary });
  return s.id;
}

// ── channel/deliver ───────────────────────────────────────────────────────────

describe("channel/deliver", () => {
  it("returns {ok: true} for a valid session + progress report", async () => {
    const sessionId = await createSession("deliver-progress");
    const res = await router.dispatch(
      createRequest(1, "channel/deliver", {
        sessionId,
        report: {
          type: "progress",
          sessionId,
          stage: "main",
          message: "working...",
        },
      }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("logs a progress event observable via app.events.list", async () => {
    const sessionId = await createSession("deliver-event-log");
    await router.dispatch(
      createRequest(1, "channel/deliver", {
        sessionId,
        report: {
          type: "progress",
          sessionId,
          stage: "main",
          message: "doing stuff",
        },
      }),
    );
    const events = await app.events.list(sessionId);
    // handleReport calls app.events.log for progress events (agent_progress type)
    expect(events.length).toBeGreaterThan(0);
  });

  it("stores a question message for question-type reports", async () => {
    const sessionId = await createSession("deliver-question");
    await router.dispatch(
      createRequest(1, "channel/deliver", {
        sessionId,
        report: {
          type: "question",
          sessionId,
          stage: "main",
          question: "Should I proceed?",
        },
      }),
    );
    const messages = await app.messages.list(sessionId);
    const q = messages.find((m: any) => m.content?.includes("Should I proceed?") || m.type === "question");
    expect(q).toBeDefined();
  });

  it("returns SESSION_NOT_FOUND for an unknown session", async () => {
    const res = await router.dispatch(
      createRequest(1, "channel/deliver", {
        sessionId: "s-does-not-exist",
        report: { type: "progress", sessionId: "s-does-not-exist", stage: "x", message: "x" },
      }),
    );
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });

  it("returns INVALID_PARAMS when sessionId is missing", async () => {
    const res = await router.dispatch(
      createRequest(1, "channel/deliver", {
        report: { type: "progress", sessionId: "x", stage: "x", message: "x" },
      }),
    );
    const err = (res as JsonRpcError).error;
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it("returns INVALID_PARAMS when report is missing", async () => {
    const sessionId = await createSession("deliver-noreport");
    const res = await router.dispatch(createRequest(1, "channel/deliver", { sessionId }));
    const err = (res as JsonRpcError).error;
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});

// ── channel/relay ─────────────────────────────────────────────────────────────

describe("channel/relay", () => {
  it("returns {ok: true} for a valid target session", async () => {
    const toSession = await createSession("relay-target");
    const res = await router.dispatch(
      createRequest(1, "channel/relay", {
        toSession,
        payload: { type: "steer", sessionId: toSession, message: "hello", from: "parent" },
      }),
    );
    // deliverToChannel will silently fail (no agent listening) but the handler
    // returns ok: true once delivery is attempted.
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });

  it("returns SESSION_NOT_FOUND for an unknown target session", async () => {
    const res = await router.dispatch(
      createRequest(1, "channel/relay", {
        toSession: "s-no-such-session",
        payload: { type: "steer", sessionId: "s-no-such-session", message: "ping", from: "x" },
      }),
    );
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });

  it("returns INVALID_PARAMS when toSession is missing", async () => {
    const res = await router.dispatch(
      createRequest(1, "channel/relay", {
        payload: { type: "steer", message: "ping" },
      }),
    );
    const err = (res as JsonRpcError).error;
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it("returns INVALID_PARAMS when payload is missing", async () => {
    const toSession = await createSession("relay-nopayload");
    const res = await router.dispatch(createRequest(1, "channel/relay", { toSession }));
    const err = (res as JsonRpcError).error;
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});
