/**
 * Pass 3 #11 -- three call sites used to invoke `app.dispatchService.dispatch`
 * without surfacing `{ok:false}` returns:
 *
 *   1. conductor/report-pipeline.ts (on_failure retry)
 *   2. services/subagents.ts        (spawnParallelSubagents)
 *   3. services/fork-join.ts        (fork)
 *
 * After Pass 1 dispatch returns a `DispatchResult`. Each site now inspects
 * the resolved result; on `ok:false` (or throw) it calls
 * `markDispatchFailedShared` so the affected session flips to `failed` and
 * a `dispatch_failed` event is logged.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { asValue } from "awilix";
import { AppContext } from "../app.js";
import { fork } from "../services/fork-join.js";
import { spawnParallelSubagents } from "../services/subagents.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

describe("Pass 3 #11: dispatch failure surfacing at the three call sites", () => {
  // ── fork-join.ts: fork() child dispatch ────────────────────────────────────
  describe("fork-join.ts: fork()", () => {
    it("marks child failed when dispatch returns {ok:false}", async () => {
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => ({ ok: false, message: "child compute unreachable" }),
        }),
      });

      const parent = await app.sessions.create({ summary: "fork ok:false test", flow: "bare" });
      await app.sessions.update(parent.id, { session_id: `ark-s-${parent.id}`, stage: "implement", status: "running" });

      const result = await fork(app, parent.id, "child task", { dispatch: true });

      // The fork primitive itself surfaces the failure to the caller.
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.message).toContain("child compute unreachable");
      }

      // The newly-created child row flipped to `failed` with the reason.
      const children = await app.sessions.getChildren(parent.id);
      expect(children).toHaveLength(1);
      expect(children[0].status).toBe("failed");
      expect(children[0].error).toContain("child compute unreachable");

      // dispatch_failed event was logged on the child.
      const events = await app.events.list(children[0].id);
      const failed = events.find((e) => e.type === "dispatch_failed");
      expect(failed).toBeTruthy();
      expect(String(failed!.data?.reason ?? "")).toContain("child compute unreachable");
    });

    it("marks child failed when dispatch throws", async () => {
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => {
            throw new Error("kaboom-fork");
          },
        }),
      });

      const parent = await app.sessions.create({ summary: "fork throw test", flow: "bare" });
      await app.sessions.update(parent.id, { session_id: `ark-s-${parent.id}`, stage: "implement", status: "running" });

      const result = await fork(app, parent.id, "child task", { dispatch: true });
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.message).toContain("kaboom-fork");
      }

      const children = await app.sessions.getChildren(parent.id);
      expect(children).toHaveLength(1);
      expect(children[0].status).toBe("failed");
      expect(children[0].error).toContain("kaboom-fork");
    });
  });

  // ── subagents.ts: spawnParallelSubagents ───────────────────────────────────
  describe("subagents.ts: spawnParallelSubagents", () => {
    it("marks each subagent failed when dispatch returns {ok:false}", async () => {
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => ({ ok: false, message: "subagent dispatch refused" }),
        }),
      });

      const parent = await app.sessions.create({ summary: "subagent ok:false test", flow: "quick" });
      await app.sessions.update(parent.id, { session_id: `ark-s-${parent.id}`, stage: "implement", status: "running" });

      const result = await spawnParallelSubagents(app, parent.id, [{ task: "task A" }, { task: "task B" }]);

      expect(result.ok).toBe(true);
      expect(result.sessionIds).toHaveLength(2);

      for (const id of result.sessionIds) {
        const child = await app.sessions.get(id);
        expect(child?.status).toBe("failed");
        expect(child?.error).toContain("subagent dispatch refused");

        const events = await app.events.list(id);
        const failed = events.find((e) => e.type === "dispatch_failed");
        expect(failed).toBeTruthy();
        expect(String(failed!.data?.reason ?? "")).toContain("subagent dispatch refused");
      }
    });

    it("marks each subagent failed when dispatch throws", async () => {
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => {
            throw new Error("kaboom-subagent");
          },
        }),
      });

      const parent = await app.sessions.create({ summary: "subagent throw test", flow: "quick" });
      await app.sessions.update(parent.id, { session_id: `ark-s-${parent.id}`, stage: "implement", status: "running" });

      const result = await spawnParallelSubagents(app, parent.id, [{ task: "task A" }]);
      expect(result.ok).toBe(true);

      const child = await app.sessions.get(result.sessionIds[0]);
      expect(child?.status).toBe("failed");
      expect(child?.error).toContain("kaboom-subagent");
    });
  });

  // ── report-pipeline.ts: on_failure retry ───────────────────────────────────
  describe("conductor/report-pipeline.ts: on_failure retry", () => {
    it("marks session failed when on_failure retry dispatch returns {ok:false}", async () => {
      // Stub dispatch to return ok:false. The retry path schedules dispatch
      // fire-and-forget, so we need to wait briefly for the .then() chain.
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => ({ ok: false, message: "retry dispatch refused" }),
        }),
      });

      const session = await app.sessions.create({ summary: "retry ok:false test", flow: "quick" });
      await app.sessions.update(session.id, {
        session_id: `ark-s-${session.id}`,
        stage: "implement",
        status: "running",
      });

      // Drive the retry path directly via the existing handleReport helper.
      // applyReport for a `error` report flags shouldRetry on the on_failure
      // configured stage. Importing the test stub helper lets us bypass the
      // stage-config dependency entirely by stubbing applyReport.
      app.container.register({
        sessionHooks: asValue({
          applyReport: async () => ({
            updates: {},
            shouldAdvance: false,
            shouldRetry: true,
            retryMaxRetries: 3,
            logEvents: [],
            busEvents: [],
          }),
          retryWithContext: async () => ({ ok: true, message: "retry-ok" }),
          mediateStageHandoff: async () => ({ ok: true }),
        }),
      });

      const { handleReport } = await import("../conductor/server/report-pipeline.js");
      await handleReport(app, session.id, {
        type: "error",
        sessionId: session.id,
        stage: "implement",
        summary: "x",
      } as any);

      // The on_failure dispatch fires-and-forgets a `.then`/`.catch` chain.
      // Wait for the next tick + a small grace window for the markDispatchFailedShared
      // writes to land.
      await new Promise((r) => setTimeout(r, 100));

      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toContain("retry dispatch refused");

      const events = await app.events.list(session.id);
      const failed = events.find((e) => e.type === "dispatch_failed");
      expect(failed).toBeTruthy();
      expect(String(failed!.data?.reason ?? "")).toContain("retry dispatch refused");
    });

    it("marks session failed when on_failure retry dispatch throws", async () => {
      app.container.register({
        dispatchService: asValue({
          dispatch: async () => {
            throw new Error("kaboom-retry");
          },
        }),
        sessionHooks: asValue({
          applyReport: async () => ({
            updates: {},
            shouldAdvance: false,
            shouldRetry: true,
            retryMaxRetries: 3,
            logEvents: [],
            busEvents: [],
          }),
          retryWithContext: async () => ({ ok: true, message: "retry-ok" }),
          mediateStageHandoff: async () => ({ ok: true }),
        }),
      });

      const session = await app.sessions.create({ summary: "retry throw test", flow: "quick" });
      await app.sessions.update(session.id, {
        session_id: `ark-s-${session.id}`,
        stage: "implement",
        status: "running",
      });

      const { handleReport } = await import("../conductor/server/report-pipeline.js");
      await handleReport(app, session.id, {
        type: "error",
        sessionId: session.id,
        stage: "implement",
        summary: "x",
      } as any);

      await new Promise((r) => setTimeout(r, 100));

      const updated = await app.sessions.get(session.id);
      expect(updated?.status).toBe("failed");
      expect(updated?.error).toContain("kaboom-retry");
    });
  });
});
