import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import {
  startSession,
  forkSession,
  cloneSession,
  pause,
  restore,
  waitForCompletion,
} from "../services/session-lifecycle.js";

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

describe("startSession", () => {
  it("creates session with pending->ready transition and first stage", () => {
    const session = startSession(app, { summary: "lifecycle-test", repo: ".", flow: "bare" });
    expect(session.id).toMatch(/^s-[0-9a-z]{10}$/);
    expect(session.summary).toBe("lifecycle-test");
    expect(session.repo).toBe(".");
  });

  it("applies agent override", () => {
    const session = startSession(app, { summary: "agent-test", repo: ".", flow: "bare", agent: "planner" });
    expect(session.agent).toBe("planner");
  });

  it("stores ticket and generates branch", () => {
    const session = startSession(app, {
      summary: "Fix auth flow",
      repo: ".",
      flow: "bare",
      ticket: "PROJ-42",
    });
    expect(session.ticket).toBe("PROJ-42");
    expect(session.branch).toBe("feat/proj-42-fix-auth-flow");
  });

  it("logs session_created event", () => {
    const session = startSession(app, { summary: "event-test", repo: ".", flow: "bare" });
    const events = app.events.list(session.id, { type: "session_created" });
    expect(events.length).toBe(1);
    expect(events[0].actor).toBe("user");
  });

  it("stores config with inputs when provided", () => {
    const session = startSession(app, {
      summary: "inputs-test",
      repo: ".",
      flow: "bare",
      inputs: {
        files: { recipe: "/tmp/r.yaml" },
        params: { key: "val" },
      },
    });
    const config = session.config as Record<string, unknown>;
    const inputs = config.inputs as { files: Record<string, string>; params: Record<string, string> };
    expect(inputs.files.recipe).toBe("/tmp/r.yaml");
    expect(inputs.params.key).toBe("val");
  });

  it("omits inputs from config when none provided", () => {
    const session = startSession(app, { summary: "no-inputs", repo: ".", flow: "bare" });
    const config = session.config as Record<string, unknown>;
    expect(config.inputs).toBeUndefined();
  });

  it("stores attachments in config", () => {
    const session = startSession(app, {
      summary: "attach-test",
      repo: ".",
      flow: "bare",
      attachments: [{ name: "spec.md", content: "# Spec", type: "text/markdown" }],
    });
    const config = session.config as Record<string, unknown>;
    const attachments = config.attachments as Array<{ name: string; content: string; type: string }>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe("spec.md");
    expect(attachments[0].content).toBe("# Spec");
  });

  it("uses custom flow", () => {
    const session = startSession(app, { summary: "flow-test", repo: ".", flow: "bare" });
    expect(session.flow).toBe("bare");
  });

  it("stores compute_name", () => {
    const session = startSession(app, {
      summary: "compute-test",
      repo: ".",
      flow: "bare",
      compute_name: "docker-1",
    });
    expect(session.compute_name).toBe("docker-1");
  });

  it("stores group_name", () => {
    const session = startSession(app, {
      summary: "group-test",
      repo: ".",
      flow: "bare",
      group_name: "team-alpha",
    });
    expect(session.group_name).toContain("team-alpha");
  });
});

describe("forkSession", () => {
  it("creates a new session from existing one", () => {
    const original = startSession(app, {
      summary: "original",
      repo: "/tmp/repo",
      flow: "bare",
      ticket: "PROJ-1",
    });
    app.sessions.update(original.id, { stage: "code", status: "running" });

    const result = forkSession(app, original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fork = app.sessions.get(result.sessionId)!;
    expect(fork.id).not.toBe(original.id);
    expect(fork.summary).toBe("original (fork)");
    expect(fork.repo).toBe("/tmp/repo");
    expect(fork.flow).toBe("bare");
    expect(fork.stage).toBe("code");
    expect(fork.status).toBe("ready");
  });

  it("uses custom name when provided", () => {
    const original = startSession(app, { summary: "base", repo: ".", flow: "bare" });
    const result = forkSession(app, original.id, "my-fork");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fork = app.sessions.get(result.sessionId)!;
    expect(fork.summary).toBe("my-fork");
  });

  it("logs session_forked event", () => {
    const original = startSession(app, { summary: "fork-event", repo: ".", flow: "bare" });
    const result = forkSession(app, original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = app.events.list(result.sessionId, { type: "session_forked" });
    expect(events.length).toBe(1);
    expect(events[0].data).toMatchObject({ forked_from: original.id });
  });

  it("returns error for nonexistent session", () => {
    const result = forkSession(app, "s-nonexistent");
    expect(result.ok).toBe(false);
  });

  it("does not copy claude_session_id", () => {
    const original = startSession(app, { summary: "fork-no-claude", repo: ".", flow: "bare" });
    app.sessions.update(original.id, { claude_session_id: "claude-uuid-123" });

    const result = forkSession(app, original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fork = app.sessions.get(result.sessionId)!;
    expect(fork.claude_session_id).toBeNull();
  });
});

describe("cloneSession", () => {
  it("creates a deep copy with claude_session_id", () => {
    const original = startSession(app, { summary: "clone-src", repo: "/tmp/repo", flow: "bare" });
    app.sessions.update(original.id, { claude_session_id: "claude-uuid-456", stage: "review" });

    const result = cloneSession(app, original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const clone = app.sessions.get(result.sessionId)!;
    expect(clone.id).not.toBe(original.id);
    expect(clone.summary).toBe("clone-src (clone)");
    expect(clone.claude_session_id).toBe("claude-uuid-456");
    expect(clone.stage).toBe("review");
    expect(clone.status).toBe("ready");
  });

  it("uses custom name when provided", () => {
    const original = startSession(app, { summary: "clone-base", repo: ".", flow: "bare" });
    const result = cloneSession(app, original.id, "my-clone");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(app.sessions.get(result.sessionId)!.summary).toBe("my-clone");
  });

  it("logs session_cloned event with claude_session_id", () => {
    const original = startSession(app, { summary: "clone-event", repo: ".", flow: "bare" });
    app.sessions.update(original.id, { claude_session_id: "c-789" });

    const result = cloneSession(app, original.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = app.events.list(result.sessionId, { type: "session_cloned" });
    expect(events.length).toBe(1);
    expect(events[0].data).toMatchObject({ cloned_from: original.id, claude_session_id: "c-789" });
  });

  it("returns error for nonexistent session", () => {
    const result = cloneSession(app, "s-nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("pause", () => {
  it("sets status to blocked with reason", () => {
    const session = startSession(app, { summary: "pause-test", repo: ".", flow: "bare" });
    app.sessions.update(session.id, { status: "running" });

    const result = pause(app, session.id, "Need review");
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(session.id)!;
    expect(updated.status).toBe("blocked");
    expect(updated.breakpoint_reason).toBe("Need review");
  });

  it("defaults reason to 'User paused'", () => {
    const session = startSession(app, { summary: "pause-default", repo: ".", flow: "bare" });
    pause(app, session.id);

    expect(app.sessions.get(session.id)!.breakpoint_reason).toBe("User paused");
  });

  it("logs session_paused event with previous status", () => {
    const session = startSession(app, { summary: "pause-event", repo: ".", flow: "bare" });
    app.sessions.update(session.id, { status: "running" });

    pause(app, session.id, "blocked on PR");

    const events = app.events.list(session.id, { type: "session_paused" });
    expect(events.length).toBe(1);
    expect(events[0].data).toMatchObject({ reason: "blocked on PR", was_status: "running" });
  });

  it("returns error for nonexistent session", () => {
    const result = pause(app, "s-nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("restore", () => {
  it("restores archived session to stopped", () => {
    const session = startSession(app, { summary: "restore-test", repo: ".", flow: "bare" });
    app.sessions.update(session.id, { status: "archived" });

    const result = restore(app, session.id);
    expect(result.ok).toBe(true);
    expect(app.sessions.get(session.id)!.status).toBe("stopped");
  });

  it("logs session_restored event", () => {
    const session = startSession(app, { summary: "restore-event", repo: ".", flow: "bare" });
    app.sessions.update(session.id, { status: "archived" });

    restore(app, session.id);

    const events = app.events.list(session.id, { type: "session_restored" });
    expect(events.length).toBe(1);
  });

  it("returns error for non-archived session", () => {
    const session = startSession(app, { summary: "restore-fail", repo: ".", flow: "bare" });
    const result = restore(app, session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not archived");
  });

  it("returns error for nonexistent session", () => {
    const result = restore(app, "s-nonexistent");
    expect(result.ok).toBe(false);
  });
});

describe("waitForCompletion", () => {
  it("returns immediately for completed session", async () => {
    const session = startSession(app, { summary: "wait-done", repo: ".", flow: "bare" });
    app.sessions.update(session.id, { status: "completed" });

    const result = await waitForCompletion(app, session.id, { timeoutMs: 1000, pollMs: 50 });
    expect(result.timedOut).toBe(false);
    expect(result.session!.status).toBe("completed");
  });

  it("returns immediately for failed session", async () => {
    const session = startSession(app, { summary: "wait-fail", repo: ".", flow: "bare" });
    app.sessions.update(session.id, { status: "failed" });

    const result = await waitForCompletion(app, session.id, { timeoutMs: 1000, pollMs: 50 });
    expect(result.timedOut).toBe(false);
    expect(result.session!.status).toBe("failed");
  });

  it("returns immediately for stopped session", async () => {
    const session = startSession(app, { summary: "wait-stop", repo: ".", flow: "bare" });
    app.sessions.update(session.id, { status: "stopped" });

    const result = await waitForCompletion(app, session.id, { timeoutMs: 1000, pollMs: 50 });
    expect(result.timedOut).toBe(false);
    expect(result.session!.status).toBe("stopped");
  });

  it("times out for running session", async () => {
    const session = startSession(app, { summary: "wait-timeout", repo: ".", flow: "bare" });
    app.sessions.update(session.id, { status: "running" });

    const result = await waitForCompletion(app, session.id, { timeoutMs: 100, pollMs: 30 });
    expect(result.timedOut).toBe(true);
    expect(result.session!.status).toBe("running");
  });

  it("returns null session for nonexistent id", async () => {
    const result = await waitForCompletion(app, "s-nonexistent", { timeoutMs: 100, pollMs: 50 });
    expect(result.session).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});
