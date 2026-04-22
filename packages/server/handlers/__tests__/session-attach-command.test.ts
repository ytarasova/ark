/**
 * session/attach-command handler tests.
 *
 * Covers the three cases the UI cares about: attachable (returns a real
 * `tmux attach` command), completed/failed/archived (returns attachable:false
 * with a reason), and not-yet-dispatched (no session_id on the row).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../../../core/app.js";
import { Router } from "../../router.js";
import { registerSessionHandlers } from "../session.js";
import { createRequest, ErrorCodes, type JsonRpcError, type JsonRpcResponse } from "../../../protocol/types.js";
import { localAdminContext } from "../../../core/auth/context.js";

let app: AppContext;
let router: Router;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  router = new Router();
  registerSessionHandlers(router, app);
});

afterAll(async () => {
  await app?.shutdown();
});

async function dispatch(method: string, params: Record<string, unknown>) {
  const ctx = localAdminContext(null);
  return router.dispatch(createRequest(1, method, params), undefined, ctx);
}

async function createSession(fields: Record<string, unknown>): Promise<string> {
  const s = await app.sessions.create({ summary: "attach-command test" } as any);
  if (Object.keys(fields).length > 0) {
    await app.sessions.update(s.id, fields as any);
  }
  return s.id;
}

describe("session/attach-command", () => {
  it("returns attachable:true + a tmux attach command for a dispatched session", async () => {
    const id = await createSession({ session_id: "ark-foo-bar-1234", status: "running" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    expect("error" in res).toBe(false);
    const result = (res as any).result;
    expect(result.attachable).toBe(true);
    expect(result.command).toBe("tmux attach -t ark-foo-bar-1234");
    expect(result.displayHint).toContain("terminal");
    expect(result.reason).toBeUndefined();
  });

  it("returns attachable:false when the session has no tmux session_id yet", async () => {
    const id = await createSession({ session_id: null, status: "pending" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    expect("error" in res).toBe(false);
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.command).toBe("");
    expect(result.reason).toContain("dispatched");
  });

  it("returns attachable:false for a completed session", async () => {
    const id = await createSession({ session_id: "ark-done-1", status: "completed" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.reason).toContain("completed");
  });

  it("returns attachable:false for a failed session", async () => {
    const id = await createSession({ session_id: "ark-oops-1", status: "failed" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.reason).toContain("failed");
  });

  it("returns attachable:false for an archived session", async () => {
    const id = await createSession({ session_id: "ark-old-1", status: "archived" });
    const res = (await dispatch("session/attach-command", { sessionId: id })) as JsonRpcResponse;
    const result = (res as any).result;
    expect(result.attachable).toBe(false);
    expect(result.reason).toContain("archived");
  });

  it("returns an RPC error for an unknown sessionId", async () => {
    const res = (await dispatch("session/attach-command", { sessionId: "s-does-not-exist" })) as JsonRpcError;
    expect(res.error?.code).toBe(ErrorCodes.SESSION_NOT_FOUND);
  });
});
