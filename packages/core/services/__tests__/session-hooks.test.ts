import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { BunSqliteAdapter } from "../../database/sqlite.js";
import type { IDatabase } from "../../database.js";
import { SessionRepository } from "../../repositories/session.js";
import { EventRepository } from "../../repositories/event.js";
import { MessageRepository } from "../../repositories/message.js";
import { TodoRepository } from "../../repositories/todo.js";
import { initSchema } from "../../repositories/schema.js";
import type { Session, SessionStatus } from "../../../types/index.js";
import { parseOnFailure, retryWithContext, applyReport } from "../session-hooks.js";
import type { OutboundMessage } from "../../conductor/channel-types.js";

let db: IDatabase;
let sessions: SessionRepository;
let events: EventRepository;
let messages: MessageRepository;
let todos: TodoRepository;

function makeApp() {
  return {
    sessions,
    events,
    messages,
    todos,
    flows: { get: () => null },
    usageRecorder: { getSessionCost: () => ({ total_tokens: 0 }) },
    transcriptParsers: { get: () => null },
  } as any;
}

function createSession(overrides?: Partial<Session>): Session {
  const s = sessions.create({ summary: "test session" });
  if (overrides) sessions.update(s.id, overrides as Partial<Session>);
  return sessions.get(s.id)!;
}

beforeEach(() => {
  db = new BunSqliteAdapter(new Database(":memory:"));
  initSchema(db);
  sessions = new SessionRepository(db);
  events = new EventRepository(db);
  messages = new MessageRepository(db);
  todos = new TodoRepository(db);
});

// ── parseOnFailure ──────────────────────────────────────────────────────────

describe("parseOnFailure", () => {
  it("returns null for undefined", () => {
    expect(parseOnFailure(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseOnFailure("")).toBeNull();
  });

  it("returns null for 'notify'", () => {
    expect(parseOnFailure("notify")).toBeNull();
  });

  it("parses retry(3)", () => {
    const result = parseOnFailure("retry(3)");
    expect(result).toEqual({ retry: true, maxRetries: 3 });
  });

  it("parses retry(1)", () => {
    const result = parseOnFailure("retry(1)");
    expect(result).toEqual({ retry: true, maxRetries: 1 });
  });

  it("parses retry(10)", () => {
    const result = parseOnFailure("retry(10)");
    expect(result).toEqual({ retry: true, maxRetries: 10 });
  });

  it("rejects malformed retry directives", () => {
    expect(parseOnFailure("retry()")).toBeNull();
    expect(parseOnFailure("retry(abc)")).toBeNull();
    expect(parseOnFailure("retry 3")).toBeNull();
    expect(parseOnFailure("RETRY(3)")).toBeNull();
  });
});

// ── retryWithContext ────────────────────────────────────────────────────────

describe("retryWithContext", () => {
  it("returns error when session not found", () => {
    const app = makeApp();
    const result = retryWithContext(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("returns error when session is not failed", () => {
    const app = makeApp();
    const s = createSession({ status: "running" as SessionStatus });
    const result = retryWithContext(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in failed state");
  });

  it("resets failed session to ready on first retry", () => {
    const app = makeApp();
    const s = createSession({ status: "failed" as SessionStatus, error: "some error" });
    const result = retryWithContext(app, s.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("1/3");
    const updated = sessions.get(s.id)!;
    expect(updated.status).toBe("ready");
    expect(updated.error).toBeNull();
  });

  it("logs retry_with_context event", () => {
    const app = makeApp();
    const s = createSession({ status: "failed" as SessionStatus, error: "oops" });
    retryWithContext(app, s.id);
    const evts = events.list(s.id, { type: "retry_with_context" });
    expect(evts.length).toBe(1);
    expect(evts[0].data.attempt).toBe(1);
    expect(evts[0].data.error).toBe("oops");
  });

  it("respects maxRetries limit", () => {
    const app = makeApp();
    const s = createSession({ status: "failed" as SessionStatus, error: "err" });

    retryWithContext(app, s.id, { maxRetries: 2 });
    sessions.update(s.id, { status: "failed" as SessionStatus, error: "err2" });
    retryWithContext(app, s.id, { maxRetries: 2 });
    sessions.update(s.id, { status: "failed" as SessionStatus, error: "err3" });

    const result = retryWithContext(app, s.id, { maxRetries: 2 });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Max retries");
  });

  it("uses default maxRetries of 3", () => {
    const app = makeApp();
    const s = createSession({ status: "failed" as SessionStatus, error: "e" });

    for (let i = 0; i < 3; i++) {
      retryWithContext(app, s.id);
      sessions.update(s.id, { status: "failed" as SessionStatus, error: "e" });
    }

    const result = retryWithContext(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Max retries (3)");
  });
});

// ── applyReport ─────────────────────────────────────────────────────────────

describe("applyReport", () => {
  it("returns empty result for nonexistent session", () => {
    const app = makeApp();
    const report: OutboundMessage = {
      type: "completed",
      sessionId: "s-nonexistent",
      stage: "plan",
      summary: "done",
      filesChanged: [],
      commits: [],
    };
    const result = applyReport(app, "s-nonexistent", report);
    expect(result.updates).toEqual({});
  });

  describe("completed report", () => {
    it("sets status to ready and triggers advance for auto-gate", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus, flow: "default" });
      const report: OutboundMessage = {
        type: "completed",
        sessionId: s.id,
        stage: "plan",
        summary: "All done",
        filesChanged: ["file.ts"],
        commits: ["abc123"],
      };
      const result = applyReport(app, s.id, report);
      expect(result.updates.status).toBe("ready");
      expect(result.updates.session_id).toBeNull();
      expect(result.updates.error).toBeNull();
      expect(result.shouldAdvance).toBe(true);
      expect(result.shouldAutoDispatch).toBe(true);
    });

    it("stores completion data in config", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report: OutboundMessage = {
        type: "completed",
        sessionId: s.id,
        stage: "impl",
        summary: "Implemented feature",
        filesChanged: ["a.ts", "b.ts"],
        commits: ["abc", "def"],
      };
      const result = applyReport(app, s.id, report);
      expect(result.updates.config).toBeDefined();
      expect((result.updates.config as any).completion_summary).toBe("Implemented feature");
      expect((result.updates.config as any).filesChanged).toEqual(["a.ts", "b.ts"]);
      expect((result.updates.config as any).commits).toEqual(["abc", "def"]);
    });

    it("captures outcome for on_outcome routing", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report = {
        type: "completed",
        sessionId: s.id,
        stage: "review",
        summary: "Reviewed",
        filesChanged: [],
        commits: [],
        outcome: "approved",
      } as unknown as OutboundMessage;
      const result = applyReport(app, s.id, report);
      expect(result.outcome).toBe("approved");
    });

    it("captures PR URL from report", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report = {
        type: "completed",
        sessionId: s.id,
        stage: "impl",
        summary: "done",
        filesChanged: [],
        commits: [],
        pr_url: "https://github.com/org/repo/pull/42",
      } as unknown as OutboundMessage;
      const result = applyReport(app, s.id, report);
      expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
      expect(result.updates.pr_url).toBe("https://github.com/org/repo/pull/42");
    });

    it("does not overwrite existing PR URL", () => {
      const app = makeApp();
      const s = createSession({
        status: "running" as SessionStatus,
        pr_url: "https://github.com/org/repo/pull/1",
      });
      const report = {
        type: "completed",
        sessionId: s.id,
        stage: "impl",
        summary: "done",
        filesChanged: [],
        commits: [],
        pr_url: "https://github.com/org/repo/pull/2",
      } as unknown as OutboundMessage;
      const result = applyReport(app, s.id, report);
      expect(result.prUrl).toBeUndefined();
    });

    it("keeps manual-gate session running on completion", () => {
      const app = {
        ...makeApp(),
        flows: {
          get: () => ({
            stages: [{ name: "plan", gate: "manual", agent: "planner" }],
          }),
        },
      };
      const s = createSession({ status: "running" as SessionStatus, flow: "custom", stage: "plan" });
      const report: OutboundMessage = {
        type: "completed",
        sessionId: s.id,
        stage: "plan",
        summary: "done",
        filesChanged: [],
        commits: [],
      };
      const result = applyReport(app, s.id, report);
      expect(result.updates.status).toBeUndefined();
      expect(result.shouldAdvance).toBeUndefined();
    });
  });

  describe("question report", () => {
    it("sets status to waiting with breakpoint reason", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report: OutboundMessage = {
        type: "question",
        sessionId: s.id,
        stage: "impl",
        question: "Which database should I use?",
      };
      const result = applyReport(app, s.id, report);
      expect(result.updates.status).toBe("waiting");
      expect(result.updates.breakpoint_reason).toBe("Which database should I use?");
    });
  });

  describe("error report", () => {
    it("sets status to failed with error message", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report: OutboundMessage = {
        type: "error",
        sessionId: s.id,
        stage: "impl",
        error: "Permission denied: /etc/shadow",
      };
      const result = applyReport(app, s.id, report);
      expect(result.updates.status).toBe("failed");
      expect(result.updates.error).toBe("Permission denied: /etc/shadow");
    });

    it("logs session_failed event with suggestions for permission errors", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report: OutboundMessage = {
        type: "error",
        sessionId: s.id,
        stage: "impl",
        error: "permission denied",
      };
      const result = applyReport(app, s.id, report);
      const failEvent = result.logEvents!.find((e) => e.type === "session_failed");
      expect(failEvent).toBeDefined();
      expect((failEvent!.opts.data as any).suggestions).toContain("Check file permissions and tool access settings");
    });

    it("logs session_failed event with suggestions for timeout errors", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report: OutboundMessage = {
        type: "error",
        sessionId: s.id,
        stage: "impl",
        error: "Request timed out",
      };
      const result = applyReport(app, s.id, report);
      const failEvent = result.logEvents!.find((e) => e.type === "session_failed");
      expect((failEvent!.opts.data as any).suggestions).toContain(
        "Consider increasing the timeout or breaking the task into smaller steps",
      );
    });

    it("logs session_failed event with suggestions for rate limit errors", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report: OutboundMessage = {
        type: "error",
        sessionId: s.id,
        stage: "impl",
        error: "429 Too Many Requests",
      };
      const result = applyReport(app, s.id, report);
      const failEvent = result.logEvents!.find((e) => e.type === "session_failed");
      expect((failEvent!.opts.data as any).suggestions).toContain(
        "Wait a few minutes and retry, or switch to a different model provider",
      );
    });

    it("provides generic suggestions for unknown errors", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report: OutboundMessage = {
        type: "error",
        sessionId: s.id,
        stage: "impl",
        error: "Something unexpected happened",
      };
      const result = applyReport(app, s.id, report);
      const failEvent = result.logEvents!.find((e) => e.type === "session_failed");
      expect((failEvent!.opts.data as any).suggestions).toContain("Check terminal output for details");
      expect((failEvent!.opts.data as any).suggestions).toContain("Try restarting the session");
    });

    it("triggers retry when on_failure directive is retry(N)", () => {
      const app = {
        ...makeApp(),
        flows: {
          get: () => ({
            stages: [{ name: "impl", gate: "auto", agent: "coder", on_failure: "retry(2)" }],
          }),
        },
      };
      const s = createSession({ status: "running" as SessionStatus, flow: "custom", stage: "impl" });
      const report: OutboundMessage = {
        type: "error",
        sessionId: s.id,
        stage: "impl",
        error: "Agent crashed",
      };
      const result = applyReport(app, s.id, report);
      expect(result.shouldRetry).toBe(true);
      expect(result.retryMaxRetries).toBe(2);
    });
  });

  describe("progress report", () => {
    it("resumes waiting session to running", () => {
      const app = makeApp();
      const s = createSession({
        status: "waiting" as SessionStatus,
        breakpoint_reason: "Waiting for answer",
      });
      const report = {
        type: "progress",
        sessionId: s.id,
        stage: "impl",
        message: "Still working...",
      } as OutboundMessage;
      const result = applyReport(app, s.id, report);
      expect(result.updates.status).toBe("running");
      expect(result.updates.breakpoint_reason).toBeNull();
    });

    it("does not change status for non-waiting sessions", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report = {
        type: "progress",
        sessionId: s.id,
        stage: "impl",
        message: "Working...",
      } as OutboundMessage;
      const result = applyReport(app, s.id, report);
      expect(result.updates.status).toBeUndefined();
    });
  });

  describe("message construction", () => {
    it("builds message with enriched content for completed reports", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report = {
        type: "completed",
        sessionId: s.id,
        stage: "impl",
        summary: "Feature done",
        filesChanged: ["src/a.ts"],
        commits: ["abc123"],
        pr_url: "https://github.com/org/repo/pull/5",
      } as unknown as OutboundMessage;
      const result = applyReport(app, s.id, report);
      expect(result.message!.role).toBe("agent");
      expect(result.message!.content).toContain("Feature done");
      expect(result.message!.content).toContain("PR: https://github.com/org/repo/pull/5");
      expect(result.message!.content).toContain("Files: src/a.ts");
      expect(result.message!.content).toContain("Commits: abc123");
    });

    it("emits bus events", () => {
      const app = makeApp();
      const s = createSession({ status: "running" as SessionStatus });
      const report: OutboundMessage = {
        type: "error",
        sessionId: s.id,
        stage: "impl",
        error: "boom",
      };
      const result = applyReport(app, s.id, report);
      expect(result.busEvents!.length).toBeGreaterThan(0);
      expect(result.busEvents![0].type).toBe("agent_error");
      expect(result.busEvents![0].sessionId).toBe(s.id);
    });
  });
});
