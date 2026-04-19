import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from "bun:test";
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
let originalDispatch: typeof app.sessionService.dispatch;

beforeEach(() => {
  router = new Router();
  originalDispatch = app.sessionService.dispatch.bind(app.sessionService);
  registerSessionHandlers(router, app);
});

describe("auto-dispatch on session creation", () => {
  it("session/dispatch RPC no longer exists", async () => {
    const startRes = await router.dispatch(
      createRequest(1, "session/start", { summary: "dispatch-removed", repo: ".", flow: "bare" }),
    );
    const session = ((startRes as JsonRpcResponse).result as Record<string, unknown>).session as Record<
      string,
      unknown
    >;

    const res = await router.dispatch(createRequest(2, "session/dispatch", { sessionId: session.id }));
    const err = (res as JsonRpcError).error;
    expect(err).toBeDefined();
    expect(err.message).toContain("Unknown method");
  });

  it("session/start emits session/created notification", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const notify = (method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params });
    };

    app.sessionService.dispatch = async () => ({ ok: true, message: "mocked" });
    const req = createRequest(1, "session/start", { summary: "notify-test", repo: ".", flow: "bare" });
    await router.dispatch(req, notify);

    const created = notifications.filter((n) => n.method === "session/created");
    expect(created.length).toBe(1);
    app.sessionService.dispatch = originalDispatch;
  });

  it("session/start returns session immediately without blocking on dispatch", async () => {
    let dispatchResolve: () => void;
    const dispatchPromise = new Promise<void>((resolve) => {
      dispatchResolve = resolve;
    });
    app.sessionService.dispatch = async () => {
      await dispatchPromise;
      return { ok: true, message: "slow dispatch" };
    };

    const req = createRequest(1, "session/start", { summary: "no-block", repo: ".", flow: "bare" });
    const start = performance.now();
    const res = await router.dispatch(req);
    const elapsed = performance.now() - start;

    const session = ((res as JsonRpcResponse).result as Record<string, unknown>).session as Record<string, unknown>;
    expect(session).toBeDefined();
    expect(session.summary).toBe("no-block");
    // RPC returns before dispatch completes
    expect(elapsed).toBeLessThan(500);

    dispatchResolve!();
    app.sessionService.dispatch = originalDispatch;
  });

  it("session/start fires dispatch and notifies session/updated on success", async () => {
    let dispatchCalled = false;
    app.sessionService.dispatch = async () => {
      dispatchCalled = true;
      return { ok: true, message: "mocked dispatch" };
    };

    const notifications: Array<{ method: string; params: unknown }> = [];
    const notify = (method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params });
    };

    const req = createRequest(1, "session/start", { summary: "auto-dispatch", repo: ".", flow: "bare" });
    await router.dispatch(req, notify);

    // Let the fire-and-forget promise settle
    await Bun.sleep(100);

    expect(dispatchCalled).toBe(true);
    const updated = notifications.filter((n) => n.method === "session/updated");
    expect(updated.length).toBeGreaterThanOrEqual(1);

    app.sessionService.dispatch = originalDispatch;
  });

  it("session/start logs dispatch_failed event and still notifies on error", async () => {
    app.sessionService.dispatch = async () => {
      throw new Error("compute unavailable");
    };

    const notifications: Array<{ method: string; params: unknown }> = [];
    const notify = (method: string, params?: Record<string, unknown>) => {
      notifications.push({ method, params });
    };

    const req = createRequest(1, "session/start", { summary: "dispatch-fail", repo: ".", flow: "bare" });
    const res = await router.dispatch(req, notify);
    const session = ((res as JsonRpcResponse).result as Record<string, unknown>).session as Record<string, unknown>;
    const sessionId = session.id as string;

    await Bun.sleep(100);

    // Error path should still notify
    const updated = notifications.filter((n) => n.method === "session/updated");
    expect(updated.length).toBeGreaterThanOrEqual(1);

    // Should have logged dispatch_failed event
    const events = app.events.list(sessionId);
    const failed = events.filter((e: any) => e.type === "dispatch_failed");
    expect(failed.length).toBe(1);

    app.sessionService.dispatch = originalDispatch;
  });
});
