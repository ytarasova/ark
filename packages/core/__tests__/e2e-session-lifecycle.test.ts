/**
 * End-to-end tests for the core session lifecycle API.
 *
 * Tests the full session lifecycle at the API level:
 * startSession -> dispatch -> getOutput -> stop -> resume -> complete -> delete.
 *
 * State isolation: ARK_TEST_DIR is set by bunfig.toml preload (packages/test-setup.ts).
 * Tmux sessions are global - use unique names and clean up in afterEach.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { startSession, dispatch, stop, resume, complete, getOutput } from "../services/session-orchestration.js";
import { sessionExists, killSession } from "../tmux.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "./test-helpers.js";

let app: AppContext;
let tmuxSnapshot: Set<string>;
beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});
afterAll(async () => {
  killNewArkTmuxSessions(tmuxSnapshot);
  await app?.shutdown();
  clearApp();
});

// Track resources for cleanup
const sessionIds: string[] = [];

afterEach(async () => {
  for (const id of sessionIds) {
    try {
      const s = app.sessions.get(id);
      if (s?.session_id) {
        try { killSession(s.session_id); } catch { /* already gone */ }
      }
      app.sessions.delete(id);
    } catch { /* already gone */ }
  }
  sessionIds.length = 0;
});

// ── startSession ───────────────────────────────────────────────────────────

describe("core lifecycle: startSession", () => {
  it("returns a valid session with correct defaults", () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-start-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    expect(session.id).toMatch(/^s-[0-9a-f]+$/);
    expect(session.status).toBe("ready");
    expect(session.flow).toBe("bare");
    expect(session.stage).toBe("work");
    expect(session.repo).toBe(process.cwd());
    expect(session.summary).toBe("lifecycle-start-test");
    expect(session.session_id).toBeNull();
    expect(session.error).toBeNull();
    expect(session.created_at).toBeTruthy();
  });

  it("logs stage_ready event on creation", () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-event-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    const events = app.events.list(session.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ready = events.find((e) => e.type === "stage_ready");
    expect(ready).toBeTruthy();
    expect(ready!.data).toBeTruthy();
    expect(ready!.data!.stage).toBe("work");
  });
});

// ── dispatch ───────────────────────────────────────────────────────────────

describe("core lifecycle: dispatch", () => {
  it("transitions session to running with tmux", async () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-dispatch-test",
      flow: "bare",
    });
    sessionIds.push(session.id);
    expect(session.status).toBe("ready");

    const result = await dispatch(app, session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("ark-");

    const dispatched = app.sessions.get(session.id)!;
    expect(dispatched.status).toBe("running");
    expect(dispatched.session_id).toBeTruthy();
    expect(dispatched.agent).toBeTruthy();

    // Verify tmux session exists
    expect(sessionExists(dispatched.session_id!)).toBe(true);

    // Clean up tmux
    await stop(app, session.id);
  }, 30_000);

  it("rejects dispatch on non-ready session", async () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-reject-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch once
    await dispatch(app, session.id);
    const s = app.sessions.get(session.id)!;
    if (s.session_id) {
      // Dispatch again - should say already running
      const result2 = await dispatch(app, session.id);
      expect(result2.message).toContain("Already running");
    }

    await stop(app, session.id);
  }, 30_000);

  it("returns error for nonexistent session", async () => {
    const result = await dispatch(app, "s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ── getOutput ──────────────────────────────────────────────────────────────

describe("core lifecycle: getOutput", () => {
  it("returns string for running session (may be empty initially)", async () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-output-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    await dispatch(app, session.id);

    // getOutput should return a string (possibly empty right after dispatch)
    const output = await getOutput(app, session.id, { lines: 10 });
    expect(typeof output).toBe("string");

    await stop(app, session.id);
  }, 30_000);

  it("returns empty string for session without tmux", async () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-no-output-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    // Not dispatched yet, so no tmux session
    const output = await getOutput(app, session.id);
    expect(output).toBe("");
  });
});

// ── stop ───────────────────────────────────────────────────────────────────

describe("core lifecycle: stop", () => {
  it("transitions running session to stopped", async () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-stop-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    await dispatch(app, session.id);
    const dispatched = app.sessions.get(session.id)!;
    expect(dispatched.status).toBe("running");

    const result = await stop(app, session.id);
    expect(result.ok).toBe(true);

    const stopped = app.sessions.get(session.id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.error).toBeNull();
    expect(stopped.session_id).toBeNull();

    // Verify tmux is dead
    expect(sessionExists(dispatched.session_id!)).toBe(false);

    // Verify stop event logged
    const events = app.events.list(session.id, { type: "session_stopped" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ── resume ─────────────────────────────────────────────────────────────────

describe("core lifecycle: resume", () => {
  it("re-dispatches a stopped session", async () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-resume-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch, then stop
    await dispatch(app, session.id);
    await stop(app, session.id);

    const stopped = app.sessions.get(session.id)!;
    expect(stopped.status).toBe("stopped");

    // Resume
    const result = await resume(app, session.id);
    expect(result.ok).toBe(true);

    const resumed = app.sessions.get(session.id)!;
    expect(resumed.status).toBe("running");
    expect(resumed.session_id).toBeTruthy();

    // Verify resume event
    const events = app.events.list(session.id, { type: "session_resumed" });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Clean up
    await stop(app, session.id);
  }, 30_000);
});

// ── complete ───────────────────────────────────────────────────────────────

describe("core lifecycle: complete", () => {
  it("advances flow when completing a stage", async () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-complete-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch so it's running
    await dispatch(app, session.id);

    // Complete the current stage
    const result = await complete(app, session.id);
    expect(result.ok).toBe(true);

    const completed = app.sessions.get(session.id)!;
    // "bare" flow has only one stage ("work"), so completing it
    // should complete the entire flow
    expect(completed.status).toBe("completed");

    // Verify stage_completed event
    const events = app.events.list(session.id, { type: "stage_completed" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ── deleteSession ──────────────────────────────────────────────────────────

describe("core lifecycle: deleteSession", () => {
  it("removes session and its events from the database", () => {
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-delete-test",
      flow: "bare",
    });
    // Don't add to sessionIds since we're deleting manually

    // Verify it exists
    expect(app.sessions.get(session.id)).not.toBeNull();
    expect(app.events.list(session.id).length).toBeGreaterThan(0);

    // Delete
    const deleted = app.sessions.delete(session.id);
    expect(deleted).toBe(true);

    // Verify it's gone
    expect(app.sessions.get(session.id)).toBeNull();
    expect(app.events.list(session.id).length).toBe(0);
  });

  it("returns false for nonexistent session", () => {
    const deleted = app.sessions.delete("s-nonexistent");
    expect(deleted).toBe(false);
  });
});

// ── Full round-trip ────────────────────────────────────────────────────────

describe("core lifecycle: full round-trip", () => {
  it("start -> dispatch -> stop -> resume -> complete -> delete", async () => {
    // 1. Start
    const session = startSession(app, {
      repo: process.cwd(),
      summary: "lifecycle-roundtrip",
      flow: "bare",
    });
    sessionIds.push(session.id);
    expect(session.status).toBe("ready");

    // 2. Dispatch
    await dispatch(app, session.id);
    expect(app.sessions.get(session.id)!.status).toBe("running");

    // 3. Stop
    await stop(app, session.id);
    expect(app.sessions.get(session.id)!.status).toBe("stopped");

    // 4. Resume (re-dispatches)
    await resume(app, session.id);
    expect(app.sessions.get(session.id)!.status).toBe("running");

    // 5. Complete (advances flow)
    complete(app, session.id);
    expect(app.sessions.get(session.id)!.status).toBe("completed");

    // 6. Delete
    const idx = sessionIds.indexOf(session.id);
    if (idx >= 0) sessionIds.splice(idx, 1);
    const deleted = app.sessions.delete(session.id);
    expect(deleted).toBe(true);
    expect(app.sessions.get(session.id)).toBeNull();
  }, 45_000);
});
