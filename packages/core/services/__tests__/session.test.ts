import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SessionService, type OutboundMessage } from "../session.js";
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

  // ── applyHookStatus() ─────────────────────────────────────────────────────

  describe("applyHookStatus", () => {
    function makeSession(overrides: Partial<Session> = {}): Session {
      return {
        id: "s-test01",
        ticket: null,
        summary: null,
        repo: null,
        branch: null,
        compute_name: null,
        session_id: null,
        claude_session_id: null,
        stage: "implement",
        status: "running",
        flow: "default",
        agent: "implementer",
        workdir: null,
        pr_url: null,
        pr_id: null,
        error: null,
        parent_id: null,
        fork_group: null,
        group_name: null,
        breakpoint_reason: null,
        attached_by: null,
        config: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...overrides,
      };
    }

    it("SessionStart sets status to running", () => {
      const session = makeSession({ status: "ready" });
      const result = svc.applyHookStatus(session, "SessionStart", {});
      expect(result.newStatus).toBe("running");
      expect(result.updates?.status).toBe("running");
    });

    it("SessionEnd sets status to completed (auto gate)", () => {
      const session = makeSession({ status: "running" });
      const result = svc.applyHookStatus(session, "SessionEnd", {});
      expect(result.newStatus).toBe("completed");
    });

    it("StopFailure sets status to failed (auto gate)", () => {
      const session = makeSession({ status: "running" });
      const result = svc.applyHookStatus(session, "StopFailure", { error: "crash" });
      expect(result.newStatus).toBe("failed");
      expect(result.updates?.error).toBe("crash");
    });

    it("guards completed sessions from being overwritten", () => {
      const session = makeSession({ status: "completed" });
      const result = svc.applyHookStatus(session, "SessionStart", {});
      expect(result.newStatus).toBeUndefined();
      expect(result.updates).toBeUndefined();
    });

    it("guards stopped sessions from being overwritten", () => {
      const session = makeSession({ status: "stopped" });
      const result = svc.applyHookStatus(session, "SessionStart", {});
      expect(result.newStatus).toBeUndefined();
      expect(result.updates).toBeUndefined();
    });

    it("guards failed sessions from running transition", () => {
      const session = makeSession({ status: "failed" });
      const result = svc.applyHookStatus(session, "SessionStart", {});
      expect(result.newStatus).toBeUndefined();
      expect(result.updates).toBeUndefined();
    });

    it("Notification with permission_prompt sets waiting", () => {
      const session = makeSession({ status: "running" });
      const result = svc.applyHookStatus(session, "Notification", { matcher: "permission_prompt" });
      expect(result.newStatus).toBe("waiting");
    });

    it("manual gate: SessionEnd does not change status", () => {
      const session = makeSession({ status: "running" });
      const result = svc.applyHookStatus(session, "SessionEnd", {}, { isManualGate: true });
      expect(result.newStatus).toBe("running");
      expect(result.updates?.status).toBe("running");
    });

    it("manual gate: StopFailure logs error but keeps running", () => {
      const session = makeSession({ status: "running" });
      const result = svc.applyHookStatus(session, "StopFailure", { error: "oops" }, { isManualGate: true });
      expect(result.newStatus).toBe("running");
      // Should have agent_error event logged
      const errorEvents = result.events!.filter(e => e.type === "agent_error");
      expect(errorEvents.length).toBe(1);
    });

    it("clears breakpoint when transitioning from waiting to running", () => {
      const session = makeSession({ status: "waiting", breakpoint_reason: "idle" });
      const result = svc.applyHookStatus(session, "UserPromptSubmit", {});
      expect(result.newStatus).toBe("running");
      expect(result.updates?.breakpoint_reason).toBeNull();
    });

    it("always logs hook_status event", () => {
      const session = makeSession({});
      const result = svc.applyHookStatus(session, "SessionStart", {});
      const hookEvents = result.events!.filter(e => e.type === "hook_status");
      expect(hookEvents.length).toBe(1);
    });
  });

  // ── applyReport() ──────────────────────────────────────────────────────────

  describe("applyReport", () => {
    it("completed report transitions to ready with shouldAdvance", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus, stage: "implement" } as Partial<Session>);
      const result = svc.applyReport(s.id, {
        type: "completed",
        sessionId: s.id,
        stage: "implement",
        summary: "Done",
        filesChanged: ["a.ts"],
        commits: ["abc123"],
      } as OutboundMessage);
      expect(result.updates.status).toBe("ready");
      expect(result.shouldAdvance).toBe(true);
      expect(result.shouldAutoDispatch).toBe(true);
      expect(result.message?.type).toBe("completed");
    });

    it("question report transitions to waiting", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = svc.applyReport(s.id, {
        type: "question",
        sessionId: s.id,
        stage: "plan",
        question: "Which API?",
      } as OutboundMessage);
      expect(result.updates.status).toBe("waiting");
      expect(result.updates.breakpoint_reason).toBe("Which API?");
    });

    it("error report transitions to failed", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = svc.applyReport(s.id, {
        type: "error",
        sessionId: s.id,
        stage: "implement",
        error: "Build failed",
      } as OutboundMessage);
      expect(result.updates.status).toBe("failed");
      expect(result.updates.error).toBe("Build failed");
    });

    it("progress report clears waiting state", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "waiting" as SessionStatus, breakpoint_reason: "idle" } as Partial<Session>);
      const result = svc.applyReport(s.id, {
        type: "progress",
        sessionId: s.id,
        stage: "implement",
        message: "Working on it",
      } as OutboundMessage);
      expect(result.updates.status).toBe("running");
      expect(result.updates.breakpoint_reason).toBeNull();
    });

    it("captures PR URL from report", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = svc.applyReport(s.id, {
        type: "completed",
        sessionId: s.id,
        stage: "implement",
        summary: "PR created",
        pr_url: "https://github.com/org/repo/pull/42",
        filesChanged: [],
        commits: [],
      } as OutboundMessage);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    });

    it("returns empty result for nonexistent session", () => {
      const result = svc.applyReport("s-000000", {
        type: "progress",
        sessionId: "s-000000",
        stage: "plan",
        message: "working",
      } as OutboundMessage);
      expect(result.updates).toEqual({});
    });

    it("logs agent event", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = svc.applyReport(s.id, {
        type: "progress",
        sessionId: s.id,
        stage: "plan",
        message: "working",
      } as OutboundMessage);
      expect(result.logEvents!.length).toBeGreaterThanOrEqual(1);
      expect(result.logEvents![0].type).toBe("agent_progress");
    });

    it("emits bus event", () => {
      const s = svc.start({});
      sessions.update(s.id, { status: "running" as SessionStatus } as Partial<Session>);
      const result = svc.applyReport(s.id, {
        type: "error",
        sessionId: s.id,
        stage: "implement",
        error: "fail",
      } as OutboundMessage);
      expect(result.busEvents!.length).toBe(1);
      expect(result.busEvents![0].type).toBe("agent_error");
    });
  });

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
