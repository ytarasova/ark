/**
 * Unit tests for SessionDispatchListeners' post-condition logic.
 *
 * The kickDispatch path now performs two checks on the resolved
 * DispatchResult:
 *   1. `ok:false` -> markDispatchFailedShared (event + status flip)
 *   2. `ok:true`  -> if the session is STILL at `ready` AND the message
 *      isn't on the "no-launch ok" allow-list, treat it as a silent
 *      launch failure and surface it the same way.
 *
 * The allow-list ("Already running", "Executed action ...",
 * "Forked into N sessions", "Dispatched to worker") covers the legitimate
 * `ok:true` paths where dispatch intentionally doesn't change session state.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";

let app: AppContext;
let unregisterDispatcher: (() => void) | null = null;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  // Wire the default `session_created -> dispatch` listener (only registered
  // by `hosted/web.ts` in production; tests opt in explicitly).
  unregisterDispatcher = app.sessionService.registerDefaultDispatcher(() => {});
});

afterAll(async () => {
  unregisterDispatcher?.();
  await app?.shutdown();
});

describe("SessionDispatchListeners post-condition check", () => {
  it("marks failed when dispatch returns ok:true but session still at ready (silent-launch-fail)", async () => {
    // Stub dispatch to return ok:true with an unrecognized message and NO
    // status flip. This mirrors the silent-launch-failure shape: the
    // launcher reported success without actually launching anything.
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({ ok: true, message: "unrecognized success message" }),
      }),
    });

    const session = await app.sessions.create({ summary: "silent ok:true test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    // Trigger the listener path the same way orchestration does.
    app.sessionService.emitSessionCreated(session.id);
    await app.sessionService.drainPendingDispatches();

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("status=ready");

    const events = await app.events.list(session.id);
    const failed = events.find((e) => e.type === "dispatch_failed");
    expect(failed).toBeTruthy();
    expect(String(failed!.data?.reason ?? "")).toContain("unrecognized success message");
  });

  it("does NOT mark failed when ok:true message is on the no-launch allow-list", async () => {
    // "Executed action 'X'" is the canonical "no launch happened" success
    // message: the action stage ran in-process, so leaving the session at
    // `ready` is correct.
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({ ok: true, message: "Executed action 'create_pr'" }),
      }),
    });

    const session = await app.sessions.create({ summary: "allow-list test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    app.sessionService.emitSessionCreated(session.id);
    await app.sessionService.drainPendingDispatches();

    const updated = await app.sessions.get(session.id);
    // No failure flip: legitimate no-launch success.
    expect(updated?.status).toBe("ready");
    expect(updated?.error).toBeFalsy();

    const events = await app.events.list(session.id);
    expect(events.find((e) => e.type === "dispatch_failed")).toBeFalsy();
  });

  it("does NOT mark failed when ok:true and session left ready (real launch happened)", async () => {
    // Real success: dispatch flipped status to `running`. The post-condition
    // check fires only when the session is *still* at `ready`.
    app.container.register({
      dispatchService: asValue({
        dispatch: async (id: string) => {
          await app.sessions.update(id, { status: "running" });
          return { ok: true, message: "launched" };
        },
      }),
    });

    const session = await app.sessions.create({ summary: "real launch test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    app.sessionService.emitSessionCreated(session.id);
    await app.sessionService.drainPendingDispatches();

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("running");

    const events = await app.events.list(session.id);
    expect(events.find((e) => e.type === "dispatch_failed")).toBeFalsy();
  });

  it("'Already running' allow-list entry: idempotent re-dispatch is silent", async () => {
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({ ok: true, message: "Already running" }),
      }),
    });

    const session = await app.sessions.create({ summary: "already running test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    app.sessionService.emitSessionCreated(session.id);
    await app.sessionService.drainPendingDispatches();

    const events = await app.events.list(session.id);
    expect(events.find((e) => e.type === "dispatch_failed")).toBeFalsy();
  });

  it("'Forked into N sessions' allow-list entry: fan-out parent stays ready", async () => {
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({ ok: true, message: "Forked into 3 sessions" }),
      }),
    });

    const session = await app.sessions.create({ summary: "fan-out parent test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    app.sessionService.emitSessionCreated(session.id);
    await app.sessionService.drainPendingDispatches();

    const events = await app.events.list(session.id);
    expect(events.find((e) => e.type === "dispatch_failed")).toBeFalsy();
  });
});
