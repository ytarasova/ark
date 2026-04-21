/**
 * SessionService tests.
 *
 * Demonstrates the DI container override pattern (awilix):
 *   - `AppContext.forTestAsync()` builds a fully wired container.
 *   - Tests can swap individual dependencies via
 *     `app.container.register({ <key>: asValue(fake) })` -- useful when the
 *     unit under test shouldn't touch the real DB / FS.
 *   - Dependencies resolve lazily, so overrides applied after boot but before
 *     first resolve take effect without re-wiring.
 *
 * Prior to the DI migration this file constructed a fresh sqlite DB +
 * repositories by hand in `beforeEach`. That's still viable for pure unit
 * tests (see the "pure unit construction" block at the bottom), but the
 * override-based approach is preferred: it exercises the real wiring graph
 * and makes dependency swaps explicit instead of implicit.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { asValue } from "awilix";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database.js";
import { AppContext } from "../../app.js";
import { SessionService } from "../session.js";
import { SessionRepository } from "../../repositories/session.js";
import { EventRepository } from "../../repositories/event.js";
import { MessageRepository } from "../../repositories/message.js";
import { initSchema } from "../../repositories/schema.js";
import type { Session, SessionStatus } from "../../../types/index.js";
import { setApp } from "../../__tests__/test-helpers.js";

let app: AppContext;
let sessions: SessionRepository;
let events: EventRepository;
let messages: MessageRepository;
let svc: SessionService;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  // Pull the wired dependencies out of the container. These are the same
  // instances the SessionService was constructed with.
  sessions = app.sessions;
  events = app.events;
  messages = app.messages;
  svc = app.sessionService;
});

afterEach(async () => {
  await app?.shutdown();
});

describe("SessionService", async () => {
  // ── start() ────────────────────────────────────────────────────────────────

  describe("start", async () => {
    it("creates a session with correct defaults", async () => {
      const s = await svc.start({});
      expect(s.id).toMatch(/^s-[0-9a-z]{10}$/);
      expect(s.status).toBe("pending");
      expect(s.flow).toBe("default");
    });

    it("stores ticket, summary, repo", async () => {
      const s = await svc.start({ ticket: "PROJ-1", summary: "Fix bug", repo: "/tmp/repo" });
      expect(s.ticket).toBe("PROJ-1");
      expect(s.summary).toBe("Fix bug");
      expect(s.repo).toBe("/tmp/repo");
    });

    it("applies agent override", async () => {
      const s = await svc.start({ agent: "planner" });
      expect(s.agent).toBe("planner");
    });

    it("logs session_created event", async () => {
      const s = await svc.start({ summary: "Test" });
      const evts = await events.list(s.id, { type: "session_created" });
      expect(evts.length).toBe(1);
      expect(evts[0].actor).toBe("system");
    });
  });

  // ── stop() ─────────────────────────────────────────────────────────────────

  describe("stop", async () => {
    it("transitions running -> stopped", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
      const updated = await sessions.get(s.id)!;
      expect(updated.status).toBe("stopped");
    });

    it("is idempotent on already-stopped", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "stopped" as SessionStatus } as Partial<Session>);
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
    });

    it("is idempotent on completed", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "completed" as SessionStatus } as Partial<Session>);
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
    });

    it("is idempotent on failed", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "failed" as SessionStatus } as Partial<Session>);
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
    });

    it("clears runtime fields (session_id, error) but preserves claude_session_id", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, {
        status: "running" as SessionStatus,
        session_id: "ark-s-abc",
        claude_session_id: "claude-123",
        error: "some error",
      } as Partial<Session>);
      await svc.stop(s.id);
      const updated = await sessions.get(s.id)!;
      expect(updated.session_id).toBeNull();
      expect(updated.error).toBeNull();
      // claude_session_id preserved for resume
      expect(updated.claude_session_id).toBe("claude-123");
    });

    it("returns error for nonexistent session", async () => {
      const result = await svc.stop("s-000000");
      expect(result.ok).toBe(false);
    });

    it("logs session_stopped event", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      await svc.stop(s.id);
      const evts = await events.list(s.id, { type: "session_stopped" });
      expect(evts.length).toBe(1);
    });
  });

  // ── resume() ───────────────────────────────────────────────────────────────

  describe("resume", async () => {
    it("transitions stopped -> ready", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "stopped" as SessionStatus } as Partial<Session>);
      const result = await svc.resume(s.id);
      expect(result.ok).toBe(true);
      expect((await sessions.get(s.id))!.status).toBe("ready");
    });

    it("fails on completed sessions", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "completed" as SessionStatus } as Partial<Session>);
      const result = await svc.resume(s.id);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("completed");
    });

    it("clears error, breakpoint_reason, attached_by, session_id", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, {
        status: "failed" as SessionStatus,
        error: "some error",
        breakpoint_reason: "waiting for input",
        attached_by: "user1",
        session_id: "ark-s-old",
      } as Partial<Session>);
      await svc.resume(s.id);
      const updated = await sessions.get(s.id)!;
      expect(updated.error).toBeNull();
      expect(updated.breakpoint_reason).toBeNull();
      expect(updated.attached_by).toBeNull();
      expect(updated.session_id).toBeNull();
    });

    it("logs session_resumed event", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "stopped" as SessionStatus } as Partial<Session>);
      await svc.resume(s.id);
      const evts = await events.list(s.id, { type: "session_resumed" });
      expect(evts.length).toBe(1);
    });

    it("returns error for nonexistent session", async () => {
      const result = await svc.resume("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── complete() ─────────────────────────────────────────────────────────────

  describe("complete", async () => {
    it("transitions to ready and clears session_id", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "running" as SessionStatus, session_id: "tmux-1" } as Partial<Session>);
      const result = await svc.complete(s.id);
      expect(result.ok).toBe(true);
      const updated = await sessions.get(s.id)!;
      expect(updated.status).toBe("ready");
      expect(updated.session_id).toBeNull();
    });

    it("marks messages as read", async () => {
      const s = await svc.start({});
      messages.send(s.id, "agent", "hello", "text");
      expect(messages.unreadCount(s.id)).toBe(1);
      await svc.complete(s.id);
      expect(messages.unreadCount(s.id)).toBe(0);
    });

    it("logs stage_completed event", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { stage: "plan" } as Partial<Session>);
      await svc.complete(s.id);
      const evts = await events.list(s.id, { type: "stage_completed" });
      expect(evts.length).toBe(1);
    });

    it("returns error for nonexistent session", async () => {
      const result = await svc.complete("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── pause() ────────────────────────────────────────────────────────────────

  describe("pause", async () => {
    it("transitions to blocked with reason", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = await svc.pause(s.id, "Need review");
      expect(result.ok).toBe(true);
      const updated = await sessions.get(s.id)!;
      expect(updated.status).toBe("blocked");
      expect(updated.breakpoint_reason).toBe("Need review");
    });

    it("defaults reason to 'User paused'", async () => {
      const s = await svc.start({});
      await svc.pause(s.id);
      expect((await sessions.get(s.id))!.breakpoint_reason).toBe("User paused");
    });

    it("logs session_paused event", async () => {
      const s = await svc.start({});
      await svc.pause(s.id);
      const evts = await events.list(s.id, { type: "session_paused" });
      expect(evts.length).toBe(1);
    });

    it("returns error for nonexistent session", async () => {
      const result = await svc.pause("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── delete() ───────────────────────────────────────────────────────────────

  describe("delete", async () => {
    it("soft-deletes session (status -> deleting)", async () => {
      const s = await svc.start({});
      const result = await svc.delete(s.id);
      expect(result.ok).toBe(true);
      const deleted = await sessions.get(s.id)!;
      expect(deleted.status).toBe("deleting");
    });

    it("logs session_deleted event", async () => {
      const s = await svc.start({});
      await svc.delete(s.id);
      const evts = await events.list(s.id, { type: "session_deleted" });
      expect(evts.length).toBe(1);
    });

    it("returns error for nonexistent session", async () => {
      const result = await svc.delete("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── undelete() ─────────────────────────────────────────────────────────────

  describe("undelete", async () => {
    it("restores a soft-deleted session", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      await svc.delete(s.id);
      const result = await svc.undelete(s.id);
      expect(result.ok).toBe(true);
      const restored = await sessions.get(s.id)!;
      expect(restored.status).toBe("running");
    });

    it("returns error for non-deleted session", async () => {
      const s = await svc.start({});
      const result = await svc.undelete(s.id);
      expect(result.ok).toBe(false);
    });

    it("logs session_undeleted event", async () => {
      const s = await svc.start({});
      await svc.delete(s.id);
      await svc.undelete(s.id);
      const evts = await events.list(s.id, { type: "session_undeleted" });
      expect(evts.length).toBe(1);
    });
  });

  // NOTE: applyHookStatus() and applyReport() tests removed -- those methods
  // were duplicate implementations that lived on SessionService. The production
  // code (standalone functions) lives in session-orchestration.ts and is tested
  // via conductor and e2e tests.

  // ── get / list ─────────────────────────────────────────────────────────────

  describe("get / list", async () => {
    it("get returns session by id", async () => {
      const s = await svc.start({ summary: "hello" });
      expect((await svc.get(s.id))!.summary).toBe("hello");
    });

    it("get returns null for nonexistent", async () => {
      expect(await svc.get("s-000000")).toBeNull();
    });

    it("list returns all sessions", async () => {
      await svc.start({ summary: "a" });
      await svc.start({ summary: "b" });
      expect((await svc.list()).length).toBe(2);
    });
  });

  // ── delegating methods (existence checks) ─────────────────────────────────

  describe("delegating methods", () => {
    it("dispatch is a function", () => {
      expect(typeof svc.dispatch).toBe("function");
    });

    it("advance is a function", () => {
      expect(typeof svc.advance).toBe("function");
    });

    it("getOutput is a function", () => {
      expect(typeof svc.getOutput).toBe("function");
    });

    it("send is a function", () => {
      expect(typeof svc.send).toBe("function");
    });

    it("waitForCompletion is a function", () => {
      expect(typeof svc.waitForCompletion).toBe("function");
    });

    it("fork is a function", () => {
      expect(typeof svc.fork).toBe("function");
    });

    it("clone is a function", () => {
      expect(typeof svc.clone).toBe("function");
    });

    it("spawn is a function", () => {
      expect(typeof svc.spawn).toBe("function");
    });

    it("handoff is a function", () => {
      expect(typeof svc.handoff).toBe("function");
    });

    it("finishWorktree is a function", () => {
      expect(typeof svc.finishWorktree).toBe("function");
    });

    it("join is a function", () => {
      expect(typeof svc.join).toBe("function");
    });

    it("approveReviewGate is a function", () => {
      expect(typeof svc.approveReviewGate).toBe("function");
    });
  });

  // ── setApp / AppContext guard ──────────────────────────────────────────

  describe("setApp", () => {
    it("setApp injects AppContext", () => {
      const mockApp = {} as any;
      svc.setApp(mockApp);
      expect(typeof svc.setApp).toBe("function");
    });
  });

  // ── list with filters ─────────────────────────────────────────────────

  describe("list with filters", async () => {
    it("list passes filters through to repository", async () => {
      await svc.start({ flow: "quick" });
      await svc.start({ flow: "default" });
      const quickSessions = await svc.list({ flow: "quick" });
      expect(quickSessions.length).toBe(1);
      expect(quickSessions[0].flow).toBe("quick");
    });

    it("list filters by status", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      await svc.start({});
      const running = await svc.list({ status: "running" });
      expect(running.length).toBe(1);
      expect(running[0].id).toBe(s.id);
    });
  });

  // ── stop edge cases ───────────────────────────────────────────────────

  describe("stop edge cases", async () => {
    it("stops a pending session (no session_id)", async () => {
      const s = await svc.start({});
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
      expect((await sessions.get(s.id))!.status).toBe("stopped");
    });

    it("returns sessionId in result", async () => {
      const s = await svc.start({});
      const result = await svc.stop(s.id);
      expect(result.sessionId).toBe(s.id);
    });
  });

  // ── resume edge cases ─────────────────────────────────────────────────

  describe("resume edge cases", async () => {
    it("resumes a failed session", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "failed" as SessionStatus } as Partial<Session>);
      const result = await svc.resume(s.id);
      expect(result.ok).toBe(true);
      expect((await sessions.get(s.id))!.status).toBe("ready");
    });

    it("resumes a blocked session", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "blocked" as SessionStatus } as Partial<Session>);
      const result = await svc.resume(s.id);
      expect(result.ok).toBe(true);
      expect((await sessions.get(s.id))!.status).toBe("ready");
    });

    it("returns sessionId in result", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "stopped" as SessionStatus } as Partial<Session>);
      const result = await svc.resume(s.id);
      expect(result.sessionId).toBe(s.id);
    });
  });

  // ── complete edge cases ───────────────────────────────────────────────

  describe("complete edge cases", async () => {
    it("returns sessionId in result", async () => {
      const s = await svc.start({});
      const result = await svc.complete(s.id);
      expect(result.sessionId).toBe(s.id);
    });
  });

  // ── pause edge cases ──────────────────────────────────────────────────

  describe("pause edge cases", async () => {
    it("returns sessionId in result", async () => {
      const s = await svc.start({});
      const result = await svc.pause(s.id);
      expect(result.sessionId).toBe(s.id);
    });

    it("logs the previous status in event data", async () => {
      const s = await svc.start({});
      await sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      await svc.pause(s.id, "Need review");
      const evts = await events.list(s.id, { type: "session_paused" });
      expect(evts.length).toBe(1);
    });
  });

  // ── delete/undelete edge cases ────────────────────────────────────────

  describe("delete/undelete edge cases", async () => {
    it("delete returns sessionId in result", async () => {
      const s = await svc.start({});
      const result = await svc.delete(s.id);
      expect(result.sessionId).toBe(s.id);
    });

    it("undelete returns sessionId in result", async () => {
      const s = await svc.start({});
      await svc.delete(s.id);
      const result = await svc.undelete(s.id);
      expect(result.sessionId).toBe(s.id);
    });

    it("undelete of nonexistent returns error", async () => {
      const result = await svc.undelete("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── DI container overrides ────────────────────────────────────────────
  //
  // These exercise the "replace a dependency with a test double" pattern.
  // The service instance resolved before the override retains the original
  // wiring (awilix singletons are cached by reference), but *re-resolving*
  // sessionService after an override gives us a fresh instance wired to the
  // fake -- proving the container can rebuild services from test doubles.

  describe("container overrides", async () => {
    it("swapping the events repo reroutes session_created logging", async () => {
      // Spy that records every event logged through the service.
      const recorded: Array<{ sessionId: string; type: string }> = [];
      const fakeEvents = {
        log: mock((sessionId: string, type: string) => {
          recorded.push({ sessionId, type });
        }),
        list: mock(() => []),
      };

      // Replace events in the container. sessionService resolves events on
      // construction, so we also need to re-resolve sessionService.
      app.container.register({
        events: asValue(fakeEvents),
        sessionService: asValue(
          new SessionService(app.sessions, fakeEvents as unknown as EventRepository, app.messages, app),
        ),
      });

      const freshSvc = app.container.resolve("sessionService");
      const s = await freshSvc.start({ summary: "override test" });

      expect(recorded.length).toBe(1);
      expect(recorded[0].sessionId).toBe(s.id);
      expect(recorded[0].type).toBe("session_created");
      expect(fakeEvents.log).toHaveBeenCalledTimes(1);
    });

    it("swapping the sessions repo with a fake lets us assert call patterns", async () => {
      // Minimal fake repo -- just enough surface for stop() to run.
      const fakeRepo = {
        get: mock((id: string) => ({ id, status: "running", session_id: null, stage: null, agent: null })),
        update: mock(() => {}),
        list: mock(() => []),
        create: mock(() => ({ id: "s-fake", status: "pending" })),
      };

      app.container.register({
        sessions: asValue(fakeRepo as unknown as SessionRepository),
        sessionService: asValue(
          new SessionService(fakeRepo as unknown as SessionRepository, app.events, app.messages, app),
        ),
      });

      const freshSvc = app.container.resolve("sessionService");
      const result = await freshSvc.stop("s-fake-id");

      expect(result.ok).toBe(true);
      expect(fakeRepo.get).toHaveBeenCalledWith("s-fake-id");
      expect(fakeRepo.update).toHaveBeenCalled();
    });
  });

  // ── Pure-unit construction (legacy, still supported) ──────────────────
  //
  // For pure unit tests that don't need the full AppContext, you can still
  // construct SessionService directly. Prefer the container path above when
  // the test touches more than one repository.

  describe("pure unit construction (no container)", async () => {
    let pureDb: IDatabase;
    let pureSvc: SessionService;

    beforeEach(async () => {
      pureDb = new BunSqliteAdapter(new Database(":memory:"));
      await initSchema(pureDb);
      pureSvc = new SessionService(
        new SessionRepository(pureDb),
        new EventRepository(pureDb),
        new MessageRepository(pureDb),
      );
    });

    it("start() works without an AppContext", async () => {
      const s = await pureSvc.start({ summary: "pure unit" });
      expect(s.id).toMatch(/^s-[0-9a-z]{10}$/);
    });
  });
});
