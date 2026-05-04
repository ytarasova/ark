/**
 * Unit tests for SessionDispatchListeners' post-condition logic.
 *
 * The kickDispatch path performs two checks on the resolved DispatchResult:
 *   1. `ok:false` -> markDispatchFailedShared (event + status flip)
 *   2. `ok:true, launched:true` -> if the session is STILL at `ready`,
 *      treat it as a silent launch failure and surface it the same way.
 *
 * `ok:true, launched:false` returns (action stage, fork parent, hosted
 * handoff, already-running noop) bypass the post-condition check by
 * contract -- the typed `launched:false` + `reason` discriminator replaces
 * the old magic-string allow-list.
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
  it("marks failed when launched:true but session still at ready (silent-launch-fail)", async () => {
    // Stub dispatch to return launched:true while leaving the session at
    // status=ready -- the typed contract violation: a successful launch
    // MUST flip status out of ready.
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({ ok: true, launched: true, message: "ark-s-test-handle" }),
      }),
    });

    const session = await app.sessions.create({ summary: "silent launched:true test", flow: "quick" });
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
    expect(String(failed!.data?.reason ?? "")).toContain("launched:true");
  });

  it("does NOT mark failed when launched:false reason:action_stage", async () => {
    // Action stage ran in-process. launched:false + reason names the case;
    // the post-condition check is bypassed by contract.
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({
          ok: true,
          launched: false,
          reason: "action_stage",
          message: "Executed action 'create_pr'",
        }),
      }),
    });

    const session = await app.sessions.create({ summary: "action stage test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    app.sessionService.emitSessionCreated(session.id);
    await app.sessionService.drainPendingDispatches();

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("ready");
    expect(updated?.error).toBeFalsy();

    const events = await app.events.list(session.id);
    expect(events.find((e) => e.type === "dispatch_failed")).toBeFalsy();
  });

  it("does NOT mark failed when launched:true and session left ready (real launch happened)", async () => {
    // Real success: dispatch flipped status to `running` and reports
    // launched:true. Post-condition refreshes the session and finds it
    // is no longer at ready -- no failure surfaced.
    app.container.register({
      dispatchService: asValue({
        dispatch: async (id: string) => {
          await app.sessions.update(id, { session_id: `ark-s-${id}`, status: "running" });
          return { ok: true, launched: true, message: "ark-s-real-launch" };
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

  it("launched:false reason:already_running -- idempotent re-dispatch is silent", async () => {
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({
          ok: true,
          launched: false,
          reason: "already_running",
          message: "Already running (ark-s-foo)",
        }),
      }),
    });

    const session = await app.sessions.create({ summary: "already running test", flow: "quick" });
    await app.sessions.update(session.id, { status: "ready", stage: "implement" });

    app.sessionService.emitSessionCreated(session.id);
    await app.sessionService.drainPendingDispatches();

    const events = await app.events.list(session.id);
    expect(events.find((e) => e.type === "dispatch_failed")).toBeFalsy();
  });

  it("launched:false reason:fork_parent -- fan-out parent stays ready", async () => {
    app.container.register({
      dispatchService: asValue({
        dispatch: async () => ({
          ok: true,
          launched: false,
          reason: "fork_parent",
          message: "Forked into 3 sessions",
        }),
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
