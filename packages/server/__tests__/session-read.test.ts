import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { Router } from "../router.js";
import { createRequest, type JsonRpcResponse, type JsonRpcError } from "../../protocol/types.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
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

function startSession(id: number, summary: string) {
  return router.dispatch(createRequest(id, "session/start", { summary, repo: ".", flow: "bare" }));
}

function readSession(id: number, sessionId: string, include?: string[]) {
  const params: Record<string, unknown> = { sessionId };
  if (include) params.include = include;
  return router.dispatch(createRequest(id, "session/read", params));
}

function result(res: unknown) {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function sessionId(res: unknown) {
  return (result(res).session as Record<string, unknown>).id as string;
}

describe("session/read", () => {
  it("returns session by id", async () => {
    const startRes = await startSession(1, "read-basic");
    const id = sessionId(startRes);
    const res = await readSession(2, id);
    const r = result(res);
    expect((r.session as Record<string, unknown>).id).toBe(id);
    expect((r.session as Record<string, unknown>).summary).toBe("read-basic");
  });

  it("returns error for unknown session id", async () => {
    const res = await readSession(1, "s-does-not-exist");
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.code).toBe(-32002);
  });

  it("returns events when include contains 'events'", async () => {
    const startRes = await startSession(1, "read-events");
    const id = sessionId(startRes);
    app.events.log(id, "test_event", { actor: "test", data: { foo: "bar" } });
    const res = await readSession(2, id, ["events"]);
    const r = result(res);
    expect(r.events).toBeDefined();
    expect(Array.isArray(r.events)).toBe(true);
    const events = r.events as Record<string, unknown>[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "test_event")).toBe(true);
    expect(r.messages).toBeUndefined();
  });

  it("returns messages when include contains 'messages'", async () => {
    const startRes = await startSession(1, "read-messages");
    const id = sessionId(startRes);
    app.messages.send(id, "user", "hello from test");
    const res = await readSession(2, id, ["messages"]);
    const r = result(res);
    expect(r.messages).toBeDefined();
    expect(Array.isArray(r.messages)).toBe(true);
    const messages = r.messages as Record<string, unknown>[];
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some((m) => m.content === "hello from test")).toBe(true);
    expect(r.events).toBeUndefined();
  });

  it("returns both events and messages when both included", async () => {
    const startRes = await startSession(1, "read-both");
    const id = sessionId(startRes);
    app.events.log(id, "combined_event", { actor: "test" });
    app.messages.send(id, "agent", "agent reply");
    const res = await readSession(2, id, ["events", "messages"]);
    const r = result(res);
    expect(r.events).toBeDefined();
    expect(r.messages).toBeDefined();
    expect((r.events as unknown[]).length).toBeGreaterThan(0);
    expect((r.messages as unknown[]).length).toBeGreaterThan(0);
  });

  it("omits events and messages when include is empty", async () => {
    const startRes = await startSession(1, "read-empty-include");
    const id = sessionId(startRes);
    app.events.log(id, "should_not_appear", { actor: "test" });
    app.messages.send(id, "user", "should not appear");
    const res = await readSession(2, id, []);
    const r = result(res);
    expect(r.session).toBeDefined();
    expect(r.events).toBeUndefined();
    expect(r.messages).toBeUndefined();
  });

  it("omits events and messages when include is not provided", async () => {
    const startRes = await startSession(1, "read-no-include");
    const id = sessionId(startRes);
    app.events.log(id, "nope", { actor: "test" });
    const res = await readSession(2, id);
    const r = result(res);
    expect(r.session).toBeDefined();
    expect(r.events).toBeUndefined();
    expect(r.messages).toBeUndefined();
  });
});
