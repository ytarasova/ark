import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

let router: Router;

beforeEach(() => {
  router = new Router();
  registerSessionHandlers(router, app);
});

describe("session handlers", () => {
  it("session/start creates a session", async () => {
    const req = createRequest(1, "session/start", { summary: "test session", repo: ".", flow: "bare" });
    const res = await router.dispatch(req);
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.session as Record<string, unknown>).toBeDefined();
    expect((result.session as Record<string, unknown>).summary).toBe("test session");
  });

  it("session/list returns sessions", async () => {
    await router.dispatch(createRequest(1, "session/start", { summary: "list-test", repo: ".", flow: "bare" }));
    const res = await router.dispatch(createRequest(2, "session/list", {}));
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect((result.sessions as unknown[]).length).toBeGreaterThan(0);
  });

  it("session/read returns session detail", async () => {
    const startRes = await router.dispatch(
      createRequest(1, "session/start", { summary: "read-test", repo: ".", flow: "bare" }),
    );
    const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
    const id = (startResult.session as Record<string, unknown>).id;
    const res = await router.dispatch(createRequest(2, "session/read", { sessionId: id }));
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect((result.session as Record<string, unknown>).id).toBe(id);
  });

  it("session/read returns error for unknown id", async () => {
    const res = await router.dispatch(createRequest(1, "session/read", { sessionId: "s-nonexistent" }));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(-32002);
  });

  it("session/update modifies session fields", async () => {
    const startRes = await router.dispatch(
      createRequest(1, "session/start", { summary: "update-test", repo: ".", flow: "bare" }),
    );
    const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
    const id = (startResult.session as Record<string, unknown>).id;
    const res = await router.dispatch(
      createRequest(2, "session/update", { sessionId: id, fields: { summary: "updated" } }),
    );
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect((result.session as Record<string, unknown>).summary).toBe("updated");
  });

  it("session/delete soft-deletes a session", async () => {
    const startRes = await router.dispatch(
      createRequest(1, "session/start", { summary: "del-test", repo: ".", flow: "bare" }),
    );
    const startResult = (startRes as JsonRpcResponse).result as Record<string, unknown>;
    const id = (startResult.session as Record<string, unknown>).id;
    const res = await router.dispatch(createRequest(2, "session/delete", { sessionId: id }));
    const result = (res as JsonRpcResponse).result as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });
});
