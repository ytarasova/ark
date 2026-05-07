/**
 * Tests for hook/forward JSON-RPC handler.
 *
 * `hook/forward` replaces POST /hooks/status from the legacy conductor REST
 * surface. It accepts two payload classes:
 *   1. Classic hook events (`hook_event_name` set) -- routes through
 *      `applyHookStatus` / guardrail evaluation.
 *   2. Channel-report passthrough (`type: "question"|"progress"|"error"`)
 *      without `hook_event_name` -- normalised and piped through `handleReport`.
 *
 * The transport-agnostic core lives in `processHookPayload`; the tests exercise
 * observable side-effects: events logged to `app.events.list`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext } from "../../core/app.js";
import { Router } from "../router.js";
import { registerHookHandlers } from "../handlers/hook.js";
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
  registerHookHandlers(router, app);
});

/** Create a session and return its id. */
async function createSession(summary = "hook-test"): Promise<string> {
  const s = await app.sessions.create({ summary });
  return s.id;
}

// ── hook/forward -- classic hook events ───────────────────────────────────────

describe("hook/forward -- PreToolUse (classic hook event)", () => {
  it("returns {ok: true} and logs a hook_status event", async () => {
    const sessionId = await createSession("hook-pretooluse");
    const res = await router.dispatch(
      createRequest(1, "hook/forward", {
        sessionId,
        payload: {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          stage: "main",
        },
      }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    // PreToolUse writes a hook_status event and returns guardrail info
    expect(result.guardrail).toBeDefined();

    const events = await app.events.list(sessionId);
    const hookEvt = events.find((e: any) => e.type === "hook_status");
    expect(hookEvt).toBeDefined();
  });

  it("returns guardrail=allow for a safe tool call", async () => {
    const sessionId = await createSession("hook-safe-tool");
    const res = await router.dispatch(
      createRequest(1, "hook/forward", {
        sessionId,
        payload: {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/tmp/safe.txt" },
          stage: "main",
        },
      }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.guardrail).toBe("allow");
  });
});

describe("hook/forward -- SessionStart", () => {
  it("returns {ok: true} and transitions a dispatched session to running", async () => {
    const sessionId = await createSession("hook-sessionstart");
    // SessionStart requires session_id to be set (the tmux session must exist
    // before the runtime fires the hook). Simulate a dispatched session.
    await app.sessions.update(sessionId, { session_id: `ark-s-${sessionId}` });

    const res = await router.dispatch(
      createRequest(1, "hook/forward", {
        sessionId,
        payload: {
          hook_event_name: "SessionStart",
          stage: "main",
        },
      }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(sessionId);
    // SessionStart transitions to running
    expect(updated?.status).toBe("running");
  });
});

// ── hook/forward -- passthrough events ───────────────────────────────────────

describe("hook/forward -- progress passthrough (no hook_event_name)", () => {
  it("returns {ok: true} and fires the report pipeline", async () => {
    const sessionId = await createSession("hook-passthrough-progress");
    const res = await router.dispatch(
      createRequest(1, "hook/forward", {
        sessionId,
        payload: {
          type: "progress",
          message: "halfway there",
          stage: "main",
        },
      }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.mapped).toBe("progress");

    const events = await app.events.list(sessionId);
    expect(events.length).toBeGreaterThan(0);
  });

  it("handles question passthrough and stores a message", async () => {
    const sessionId = await createSession("hook-passthrough-question");
    await router.dispatch(
      createRequest(1, "hook/forward", {
        sessionId,
        payload: {
          type: "question",
          question: "Shall we proceed?",
          stage: "main",
        },
      }),
    );
    const messages = await app.messages.list(sessionId);
    const q = messages.find((m: any) => m.content?.includes("Shall we proceed?") || m.type === "question");
    expect(q).toBeDefined();
  });
});

// ── hook/forward -- error cases ───────────────────────────────────────────────

describe("hook/forward -- error cases", () => {
  it("returns SESSION_NOT_FOUND for an unknown session", async () => {
    const res = await router.dispatch(
      createRequest(1, "hook/forward", {
        sessionId: "s-no-such-session",
        payload: { hook_event_name: "SessionStart", stage: "x" },
      }),
    );
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });

  it("returns INVALID_PARAMS when sessionId is missing", async () => {
    const res = await router.dispatch(
      createRequest(1, "hook/forward", {
        payload: { hook_event_name: "SessionStart" },
      }),
    );
    const err = (res as JsonRpcError).error;
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });

  it("returns INVALID_PARAMS when payload is missing", async () => {
    const sessionId = await createSession("hook-nopayload");
    const res = await router.dispatch(createRequest(1, "hook/forward", { sessionId }));
    const err = (res as JsonRpcError).error;
    expect(err.code).toBe(ErrorCodes.INVALID_PARAMS);
  });
});
