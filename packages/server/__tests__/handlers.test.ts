import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest } from "../../protocol/types.js";

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
    expect((res as any).result.session).toBeDefined();
    expect((res as any).result.session.summary).toBe("test session");
  });

  it("session/list returns sessions", async () => {
    await router.dispatch(createRequest(1, "session/start", { summary: "list-test", repo: ".", flow: "bare" }));
    const res = await router.dispatch(createRequest(2, "session/list", {}));
    expect((res as any).result.sessions.length).toBeGreaterThan(0);
  });

  it("session/read returns session detail", async () => {
    const startRes = await router.dispatch(createRequest(1, "session/start", { summary: "read-test", repo: ".", flow: "bare" }));
    const id = (startRes as any).result.session.id;
    const res = await router.dispatch(createRequest(2, "session/read", { sessionId: id }));
    expect((res as any).result.session.id).toBe(id);
  });

  it("session/read returns error for unknown id", async () => {
    const res = await router.dispatch(createRequest(1, "session/read", { sessionId: "s-nonexistent" }));
    expect((res as any).error).toBeDefined();
    expect((res as any).error.code).toBe(-32002);
  });

  it("session/update modifies session fields", async () => {
    const startRes = await router.dispatch(createRequest(1, "session/start", { summary: "update-test", repo: ".", flow: "bare" }));
    const id = (startRes as any).result.session.id;
    const res = await router.dispatch(createRequest(2, "session/update", { sessionId: id, fields: { summary: "updated" } }));
    expect((res as any).result.session.summary).toBe("updated");
  });

  it("session/delete soft-deletes a session", async () => {
    const startRes = await router.dispatch(createRequest(1, "session/start", { summary: "del-test", repo: ".", flow: "bare" }));
    const id = (startRes as any).result.session.id;
    const res = await router.dispatch(createRequest(2, "session/delete", { sessionId: id }));
    expect((res as any).result.ok).toBe(true);
  });
});
