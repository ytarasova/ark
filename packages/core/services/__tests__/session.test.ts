import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionService } from "../session.js";
import { SessionRepository } from "../../repositories/session.js";
import { EventRepository } from "../../repositories/event.js";
import { MessageRepository } from "../../repositories/message.js";
import { initSchema } from "../../repositories/schema.js";
import type { Session, SessionStatus, SessionOpResult } from "../../../types/index.js";

let db: Database;
let sessions: SessionRepository;
let events: EventRepository;
let messages: MessageRepository;
let svc: SessionService;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
  sessions = new SessionRepository(db);
  events = new EventRepository(db);
  messages = new MessageRepository(db);
  svc = new SessionService(sessions, events, messages);
});

describe("SessionService", () => {
  // ── start() ────────────────────────────────────────────────────────────────

  describe("start", () => {
    it("creates a session with correct defaults", () => {
      const s = svc.start({});
      expect(s.id).toMatch(/^s-[0-9a-f]{6}$/);
      expect(s.status).toBe("pending");
      expect(s.flow).toBe("default");
    });

    it("stores ticket, summary, repo", () => {
      const s = svc.start({ ticket: "PROJ-1", summary: "Fix bug", repo: "/tmp/repo" });
      expect(s.ticket).toBe("PROJ-1");
      expect(s.summary).toBe("Fix bug");
      expect(s.repo).toBe("/tmp/repo");
    });

    it("applies agent override", () => {
      const s = svc.start({ agent: "planner" });
      expect(s.agent).toBe("planner");
    });

    it("logs session_created event", () => {
      const s = svc.start({ summary: "Test" });
      const evts = events.list(s.id, { type: "session_created" });
      expect(evts.length).toBe(1);
      expect(evts[0].actor).toBe("system");
    });
  });

  // ── stop() ─────────────────────────────────────────────────────────────────

  describe("stop", () => {
    it("transitions running -> stopped", async () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
      const updated = sessions.get(s.id)!;
      expect(updated.status).toBe("stopped");
    });

    it("is idempotent on already-stopped", async () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "stopped" as SessionStatus } as Partial<Session>);
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
    });

    it("is idempotent on completed", async () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "completed" as SessionStatus } as Partial<Session>);
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
    });

    it("is idempotent on failed", async () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "failed" as SessionStatus } as Partial<Session>);
      const result = await svc.stop(s.id);
      expect(result.ok).toBe(true);
    });

    it("clears runtime fields (session_id, error) but preserves claude_session_id", async () => {
      const s = svc.start({});
      sessions.update(s.id, {
        status: "running" as SessionStatus,
        session_id: "ark-s-abc",
        claude_session_id: "claude-123",
        error: "some error",
      } as Partial<Session>);
      await svc.stop(s.id);
      const updated = sessions.get(s.id)!;
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
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      await svc.stop(s.id);
      const evts = events.list(s.id, { type: "session_stopped" });
      expect(evts.length).toBe(1);
    });
  });

  // ── resume() ───────────────────────────────────────────────────────────────

  describe("resume", () => {
    it("transitions stopped -> ready", async () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "stopped" as SessionStatus } as Partial<Session>);
      const result = await svc.resume(s.id);
      expect(result.ok).toBe(true);
      expect(sessions.get(s.id)!.status).toBe("ready");
    });

    it("fails on completed sessions", async () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "completed" as SessionStatus } as Partial<Session>);
      const result = await svc.resume(s.id);
      expect(result.ok).toBe(false);
      expect(result.message).toContain("completed");
    });

    it("clears error, breakpoint_reason, attached_by, session_id", async () => {
      const s = svc.start({});
      sessions.update(s.id, {
        status: "failed" as SessionStatus,
        error: "some error",
        breakpoint_reason: "waiting for input",
        attached_by: "user1",
        session_id: "ark-s-old",
      } as Partial<Session>);
      await svc.resume(s.id);
      const updated = sessions.get(s.id)!;
      expect(updated.error).toBeNull();
      expect(updated.breakpoint_reason).toBeNull();
      expect(updated.attached_by).toBeNull();
      expect(updated.session_id).toBeNull();
    });

    it("logs session_resumed event", async () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "stopped" as SessionStatus } as Partial<Session>);
      await svc.resume(s.id);
      const evts = events.list(s.id, { type: "session_resumed" });
      expect(evts.length).toBe(1);
    });

    it("returns error for nonexistent session", async () => {
      const result = await svc.resume("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── complete() ─────────────────────────────────────────────────────────────

  describe("complete", () => {
    it("transitions to ready and clears session_id", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus, session_id: "tmux-1" } as Partial<Session>);
      const result = svc.complete(s.id);
      expect(result.ok).toBe(true);
      const updated = sessions.get(s.id)!;
      expect(updated.status).toBe("ready");
      expect(updated.session_id).toBeNull();
    });

    it("marks messages as read", () => {
      const s = svc.start({});
      messages.send(s.id, "agent", "hello", "text");
      expect(messages.unreadCount(s.id)).toBe(1);
      svc.complete(s.id);
      expect(messages.unreadCount(s.id)).toBe(0);
    });

    it("logs stage_completed event", () => {
      const s = svc.start({});
      sessions.update(s.id, { stage: "plan" } as Partial<Session>);
      svc.complete(s.id);
      const evts = events.list(s.id, { type: "stage_completed" });
      expect(evts.length).toBe(1);
    });

    it("returns error for nonexistent session", () => {
      const result = svc.complete("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── pause() ────────────────────────────────────────────────────────────────

  describe("pause", () => {
    it("transitions to blocked with reason", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = svc.pause(s.id, "Need review");
      expect(result.ok).toBe(true);
      const updated = sessions.get(s.id)!;
      expect(updated.status).toBe("blocked");
      expect(updated.breakpoint_reason).toBe("Need review");
    });

    it("defaults reason to 'User paused'", () => {
      const s = svc.start({});
      svc.pause(s.id);
      expect(sessions.get(s.id)!.breakpoint_reason).toBe("User paused");
    });

    it("logs session_paused event", () => {
      const s = svc.start({});
      svc.pause(s.id);
      const evts = events.list(s.id, { type: "session_paused" });
      expect(evts.length).toBe(1);
    });

    it("returns error for nonexistent session", () => {
      const result = svc.pause("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── delete() ───────────────────────────────────────────────────────────────

  describe("delete", () => {
    it("soft-deletes session (status -> deleting)", async () => {
      const s = svc.start({});
      const result = await svc.delete(s.id);
      expect(result.ok).toBe(true);
      const deleted = sessions.get(s.id)!;
      expect(deleted.status).toBe("deleting");
    });

    it("logs session_deleted event", async () => {
      const s = svc.start({});
      await svc.delete(s.id);
      const evts = events.list(s.id, { type: "session_deleted" });
      expect(evts.length).toBe(1);
    });

    it("returns error for nonexistent session", async () => {
      const result = await svc.delete("s-000000");
      expect(result.ok).toBe(false);
    });
  });

  // ── undelete() ─────────────────────────────────────────────────────────────

  describe("undelete", () => {
    it("restores a soft-deleted session", async () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      await svc.delete(s.id);
      const result = await svc.undelete(s.id);
      expect(result.ok).toBe(true);
      const restored = sessions.get(s.id)!;
      expect(restored.status).toBe("running");
    });

    it("returns error for non-deleted session", async () => {
      const s = svc.start({});
      const result = await svc.undelete(s.id);
      expect(result.ok).toBe(false);
    });

    it("logs session_undeleted event", async () => {
      const s = svc.start({});
      await svc.delete(s.id);
      await svc.undelete(s.id);
      const evts = events.list(s.id, { type: "session_undeleted" });
      expect(evts.length).toBe(1);
    });
  });

  // NOTE: applyHookStatus() and applyReport() tests removed -- those methods
  // were duplicate implementations that lived on SessionService. The production
  // code (standalone functions) lives in session-orchestration.ts and is tested
  // via conductor and e2e tests.

  // ── get / list ─────────────────────────────────────────────────────────────

  describe("get / list", () => {
    it("get returns session by id", () => {
      const s = svc.start({ summary: "hello" });
      expect(svc.get(s.id)!.summary).toBe("hello");
    });

    it("get returns null for nonexistent", () => {
      expect(svc.get("s-000000")).toBeNull();
    });

    it("list returns all sessions", () => {
      svc.start({ summary: "a" });
      svc.start({ summary: "b" });
      expect(svc.list().length).toBe(2);
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
});
