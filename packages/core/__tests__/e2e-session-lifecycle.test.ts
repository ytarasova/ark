/**
 * End-to-end tests for the core session lifecycle API.
 *
 * Tests the full session lifecycle at the API level:
 * startSession -> dispatch -> getOutput -> stop -> resume -> complete -> delete.
 *
 * State isolation: ARK_TEST_DIR is set by bunfig.toml preload (packages/test-setup.ts).
 * Tmux sessions are global - use unique names and clean up in afterEach.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as core from "../index.js";

// Track resources for cleanup
const sessionIds: string[] = [];

afterEach(async () => {
  for (const id of sessionIds) {
    try {
      const s = core.getSession(id);
      if (s?.session_id) {
        try { core.killSession(s.session_id); } catch { /* already gone */ }
      }
      core.deleteSession(id);
    } catch { /* already gone */ }
  }
  sessionIds.length = 0;
});

// ── startSession ───────────────────────────────────────────────────────────

describe("core lifecycle: startSession", () => {
  it("returns a valid session with correct defaults", () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-start-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);

    expect(session.id).toMatch(/^s-[0-9a-f]+$/);
    expect(session.status).toBe("ready");
    expect(session.pipeline).toBe("bare");
    expect(session.stage).toBe("work");
    expect(session.repo).toBe(process.cwd());
    expect(session.summary).toBe("lifecycle-start-test");
    expect(session.session_id).toBeNull();
    expect(session.error).toBeNull();
    expect(session.created_at).toBeTruthy();
  });

  it("logs session_created event", () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-event-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);

    const events = core.getEvents(session.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const created = events.find((e) => e.type === "session_created");
    expect(created).toBeTruthy();
    expect(created!.data).toBeTruthy();
    expect(created!.data!.pipeline).toBe("bare");
  });
});

// ── dispatch ───────────────────────────────────────────────────────────────

describe("core lifecycle: dispatch", () => {
  it("transitions session to running with tmux", async () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-dispatch-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);
    expect(session.status).toBe("ready");

    const result = await core.dispatch(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("ark-");

    const dispatched = core.getSession(session.id)!;
    expect(dispatched.status).toBe("running");
    expect(dispatched.session_id).toBeTruthy();
    expect(dispatched.agent).toBeTruthy();

    // Verify tmux session exists
    expect(core.sessionExists(dispatched.session_id!)).toBe(true);

    // Clean up tmux
    core.stop(session.id);
  }, 30_000);

  it("rejects dispatch on non-ready session", async () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-reject-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch once
    await core.dispatch(session.id);
    const s = core.getSession(session.id)!;
    if (s.session_id) {
      // Dispatch again - should say already running
      const result2 = await core.dispatch(session.id);
      expect(result2.message).toContain("Already running");
    }

    core.stop(session.id);
  }, 30_000);

  it("returns error for nonexistent session", async () => {
    const result = await core.dispatch("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ── getOutput ──────────────────────────────────────────────────────────────

describe("core lifecycle: getOutput", () => {
  it("returns string for running session (may be empty initially)", async () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-output-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);

    await core.dispatch(session.id);

    // getOutput should return a string (possibly empty right after dispatch)
    const output = core.getOutput(session.id, { lines: 10 });
    expect(typeof output).toBe("string");

    core.stop(session.id);
  }, 30_000);

  it("returns empty string for session without tmux", () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-no-output-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);

    // Not dispatched yet, so no tmux session
    const output = core.getOutput(session.id);
    expect(output).toBe("");
  });
});

// ── stop ───────────────────────────────────────────────────────────────────

describe("core lifecycle: stop", () => {
  it("transitions running session to failed", async () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-stop-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);

    await core.dispatch(session.id);
    const dispatched = core.getSession(session.id)!;
    expect(dispatched.status).toBe("running");

    const result = core.stop(session.id);
    expect(result.ok).toBe(true);

    const stopped = core.getSession(session.id)!;
    expect(stopped.status).toBe("failed");
    expect(stopped.error).toContain("Stopped by user");
    expect(stopped.session_id).toBeNull();

    // Verify tmux is dead
    expect(core.sessionExists(dispatched.session_id!)).toBe(false);

    // Verify stop event logged
    const events = core.getEvents(session.id, { type: "session_stopped" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ── resume ─────────────────────────────────────────────────────────────────

describe("core lifecycle: resume", () => {
  it("re-dispatches a stopped session", async () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-resume-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch, then stop
    await core.dispatch(session.id);
    core.stop(session.id);

    const stopped = core.getSession(session.id)!;
    expect(stopped.status).toBe("failed");

    // Resume
    const result = await core.resume(session.id);
    expect(result.ok).toBe(true);

    const resumed = core.getSession(session.id)!;
    expect(resumed.status).toBe("running");
    expect(resumed.session_id).toBeTruthy();

    // Verify resume event
    const events = core.getEvents(session.id, { type: "session_resumed" });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Clean up
    core.stop(session.id);
  }, 30_000);
});

// ── complete ───────────────────────────────────────────────────────────────

describe("core lifecycle: complete", () => {
  it("advances pipeline when completing a stage", async () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-complete-test",
      pipeline: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch so it's running
    await core.dispatch(session.id);

    // Complete the current stage
    const result = core.complete(session.id);
    expect(result.ok).toBe(true);

    const completed = core.getSession(session.id)!;
    // "bare" pipeline has only one stage ("work"), so completing it
    // should complete the entire pipeline
    expect(completed.status).toBe("completed");

    // Verify stage_completed event
    const events = core.getEvents(session.id, { type: "stage_completed" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ── deleteSession ──────────────────────────────────────────────────────────

describe("core lifecycle: deleteSession", () => {
  it("removes session and its events from the database", () => {
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-delete-test",
      pipeline: "bare",
    });
    // Don't add to sessionIds since we're deleting manually

    // Verify it exists
    expect(core.getSession(session.id)).not.toBeNull();
    expect(core.getEvents(session.id).length).toBeGreaterThan(0);

    // Delete
    const deleted = core.deleteSession(session.id);
    expect(deleted).toBe(true);

    // Verify it's gone
    expect(core.getSession(session.id)).toBeNull();
    expect(core.getEvents(session.id).length).toBe(0);
  });

  it("returns false for nonexistent session", () => {
    const deleted = core.deleteSession("s-nonexistent");
    expect(deleted).toBe(false);
  });
});

// ── Full round-trip ────────────────────────────────────────────────────────

describe("core lifecycle: full round-trip", () => {
  it("start -> dispatch -> stop -> resume -> complete -> delete", async () => {
    // 1. Start
    const session = core.startSession({
      repo: process.cwd(),
      summary: "lifecycle-roundtrip",
      pipeline: "bare",
    });
    sessionIds.push(session.id);
    expect(session.status).toBe("ready");

    // 2. Dispatch
    await core.dispatch(session.id);
    expect(core.getSession(session.id)!.status).toBe("running");

    // 3. Stop
    core.stop(session.id);
    expect(core.getSession(session.id)!.status).toBe("failed");

    // 4. Resume (re-dispatches)
    await core.resume(session.id);
    expect(core.getSession(session.id)!.status).toBe("running");

    // 5. Complete (advances pipeline)
    core.complete(session.id);
    expect(core.getSession(session.id)!.status).toBe("completed");

    // 6. Delete
    const idx = sessionIds.indexOf(session.id);
    if (idx >= 0) sessionIds.splice(idx, 1);
    const deleted = core.deleteSession(session.id);
    expect(deleted).toBe(true);
    expect(core.getSession(session.id)).toBeNull();
  }, 45_000);
});
