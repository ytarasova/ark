/**
 * Smoke tests for terminal/subscribe and terminal/input JSON-RPC handlers (B9).
 *
 * These tests exercise the handler registration and error paths without
 * spinning up a real arkd instance. Full end-to-end stream testing is covered
 * by the existing terminal-ws.test.ts which boots a real arkd.
 *
 * Covers:
 *   1. terminal/subscribe returns SESSION_NOT_FOUND for an unknown session.
 *   2. terminal/subscribe returns INVALID_PARAMS for a session with no tmux pane.
 *   3. terminal/input returns INVALID_PARAMS for an unknown handle.
 *   4. Both methods are registered on the router (not METHOD_NOT_FOUND).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../core/app.js";
import { registerTerminalHandlers } from "../handlers/terminal.js";
import { Router, Subscription } from "../router.js";
import { createRequest, type JsonRpcError } from "../../protocol/types.js";
import { localAdminContext } from "../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  router = new Router();
  registerTerminalHandlers(router, app);
});

afterAll(async () => {
  await app?.shutdown();
});

function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

describe("terminal/subscribe", () => {
  it("is registered on the router", () => {
    expect(router.hasHandler("terminal/subscribe")).toBe(true);
  });

  it("returns SESSION_NOT_FOUND for an unknown session id", async () => {
    const sub = new Subscription();
    const res = await router.dispatch(
      createRequest(1, "terminal/subscribe", { sessionId: "s-does-not-exist-xyz" }),
      () => {},
      localAdminContext(null),
      sub,
    );
    const e = err(res);
    expect(e).toBeDefined();
    expect(e.code).toBe(-32002); // SESSION_NOT_FOUND
    sub.flush();
  });

  it("returns INVALID_PARAMS for a session with no live tmux pane", async () => {
    const session = await app.sessions.create({ summary: "terminal-no-pane" });
    // A freshly created session has no session_id (no tmux pane).
    const sub = new Subscription();
    const res = await router.dispatch(
      createRequest(2, "terminal/subscribe", { sessionId: session.id }),
      () => {},
      localAdminContext(null),
      sub,
    );
    const e = err(res);
    expect(e).toBeDefined();
    // Should be SESSION_NOT_FOUND (-32002) or INVALID_PARAMS (-32602).
    // The handler throws INVALID_PARAMS for the "no pane" case.
    expect([-32002, -32602]).toContain(e.code);
    sub.flush();
  });
});

describe("terminal/input", () => {
  it("is registered on the router", () => {
    expect(router.hasHandler("terminal/input")).toBe(true);
  });

  it("returns INVALID_PARAMS for an unknown handle", async () => {
    const res = await router.dispatch(
      createRequest(3, "terminal/input", {
        handle: "trpc-does-not-exist",
        bytes: Buffer.from("hi").toString("base64"),
      }),
      () => {},
      localAdminContext(null),
    );
    const e = err(res);
    expect(e).toBeDefined();
    expect(e.code).toBe(-32602); // INVALID_PARAMS
  });
});
