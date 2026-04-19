import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../../core/app.js";
import { registerSessionHandlers } from "../handlers/session.js";
import { registerResourceHandlers } from "../handlers/resource.js";
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
  registerResourceHandlers(router, app);
});

function ok(res: unknown): Record<string, unknown> {
  return (res as JsonRpcResponse).result as Record<string, unknown>;
}

function err(res: unknown): { code: number; message: string } {
  return (res as JsonRpcError).error as { code: number; message: string };
}

async function createSession(summary: string): Promise<string> {
  const res = await router.dispatch(createRequest(1, "session/start", { summary, repo: ".", flow: "bare" }));
  return (ok(res).session as Record<string, unknown>).id as string;
}

// ── session/read ───────────────────────────────────────────────────────────

describe("session/read", () => {
  it("returns session by id", async () => {
    const id = await createSession("read-basic");
    const res = await router.dispatch(createRequest(2, "session/read", { sessionId: id }));
    const result = ok(res);
    expect((result.session as Record<string, unknown>).id).toBe(id);
    expect((result.session as Record<string, unknown>).summary).toBe("read-basic");
  });

  it("returns error for unknown session id", async () => {
    const res = await router.dispatch(createRequest(1, "session/read", { sessionId: "s-does-not-exist" }));
    expect(err(res)).toBeDefined();
    expect(err(res).code).toBe(-32002);
  });

  it("includes events when requested", async () => {
    const id = await createSession("read-events");
    app.events.log(id, "test-event", { stage: "init", data: { foo: "bar" } });

    const res = await router.dispatch(createRequest(2, "session/read", { sessionId: id, include: ["events"] }));
    const result = ok(res);
    expect(result.events).toBeDefined();
    const events = result.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "test-event")).toBe(true);
  });

  it("includes messages when requested", async () => {
    const id = await createSession("read-messages");
    app.messages.send(id, "user", "hello from test");

    const res = await router.dispatch(createRequest(2, "session/read", { sessionId: id, include: ["messages"] }));
    const result = ok(res);
    expect(result.messages).toBeDefined();
    const messages = result.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.some((m) => m.content === "hello from test")).toBe(true);
  });

  it("includes both events and messages when requested", async () => {
    const id = await createSession("read-both");
    app.events.log(id, "both-event");
    app.messages.send(id, "system", "both-msg");

    const res = await router.dispatch(
      createRequest(2, "session/read", { sessionId: id, include: ["events", "messages"] }),
    );
    const result = ok(res);
    expect(result.events).toBeDefined();
    expect(result.messages).toBeDefined();
    expect((result.events as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect((result.messages as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("omits events and messages when include is not specified", async () => {
    const id = await createSession("read-no-include");
    app.events.log(id, "omitted-event");
    app.messages.send(id, "user", "omitted-msg");

    const res = await router.dispatch(createRequest(2, "session/read", { sessionId: id }));
    const result = ok(res);
    expect(result.events).toBeUndefined();
    expect(result.messages).toBeUndefined();
  });
});

// ── agent/read ─────────────────────────────────────────────────────────────

describe("agent/read", () => {
  it("returns a builtin agent", async () => {
    const res = await router.dispatch(createRequest(1, "agent/read", { name: "implementer" }));
    const result = ok(res);
    expect(result.agent).toBeDefined();
    expect((result.agent as Record<string, unknown>).name).toBe("implementer");
  });

  it("returns error for unknown agent", async () => {
    const res = await router.dispatch(createRequest(1, "agent/read", { name: "no-such-agent-xyz" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("not found");
  });
});

// ── flow/read ──────────────────────────────────────────────────────────────

describe("flow/read", () => {
  it("returns a builtin flow", async () => {
    const res = await router.dispatch(createRequest(1, "flow/read", { name: "default" }));
    const result = ok(res);
    expect(result.flow).toBeDefined();
    expect((result.flow as Record<string, unknown>).name).toBe("default");
    expect((result.flow as Record<string, unknown>).stages).toBeDefined();
  });

  it("returns error for unknown flow", async () => {
    const res = await router.dispatch(createRequest(1, "flow/read", { name: "no-such-flow-xyz" }));
    expect(err(res)).toBeDefined();
    expect(err(res).message).toContain("not found");
  });
});

// ── compute/read ───────────────────────────────────────────────────────────

describe("compute/read", () => {
  it("returns a compute target after creation", async () => {
    const name = `read-test-${Date.now()}`;
    await router.dispatch(createRequest(1, "compute/create", { name, provider: "docker" }));

    const res = await router.dispatch(createRequest(2, "compute/read", { name }));
    const result = ok(res);
    expect(result.compute).toBeDefined();
    expect((result.compute as Record<string, unknown>).name).toBe(name);
    expect((result.compute as Record<string, unknown>).provider).toBe("docker");
  });

  it("returns error for unknown compute", async () => {
    const res = await router.dispatch(createRequest(1, "compute/read", { name: "no-such-compute-xyz" }));
    expect(err(res)).toBeDefined();
  });
});
