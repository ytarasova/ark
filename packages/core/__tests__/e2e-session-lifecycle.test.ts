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
import { AppContext } from "../app.js";
import { getOutput } from "../services/session-output.js";
import { sessionExists, killSession } from "../infra/tmux.js";
import { snapshotArkTmuxSessions, killNewArkTmuxSessions } from "./test-helpers.js";

let app: AppContext;
let tmuxSnapshot: Set<string>;
beforeAll(async () => {
  tmuxSnapshot = snapshotArkTmuxSessions();
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  if (app?.sessionService) await app.sessionService.stopAll();
  killNewArkTmuxSessions(tmuxSnapshot);
  await app?.shutdown();
});

// Track resources for cleanup
const sessionIds: string[] = [];

afterEach(async () => {
  for (const id of sessionIds) {
    try {
      const s = await app.sessions.get(id);
      if (s?.session_id) {
        try {
          killSession(s.session_id);
        } catch {
          /* already gone */
        }
      }
      await app.sessions.delete(id);
    } catch {
      /* already gone */
    }
  }
  sessionIds.length = 0;
});

// ── startSession ───────────────────────────────────────────────────────────

describe("core lifecycle: startSession", async () => {
  it("returns a valid session with correct defaults", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-start-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    expect(session.id).toMatch(/^s-[0-9a-z]+$/);
    expect(session.status).toBe("ready");
    expect(session.flow).toBe("bare");
    expect(session.stage).toBe("work");
    expect(session.repo).toBe(process.cwd());
    expect(session.summary).toBe("lifecycle-start-test");
    expect(session.session_id).toBeNull();
    expect(session.error).toBeNull();
    expect(session.created_at).toBeTruthy();
  });

  it("logs stage_ready event on creation", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-event-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    const events = await app.events.list(session.id);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ready = events.find((e) => e.type === "stage_ready");
    expect(ready).toBeTruthy();
    expect(ready!.data).toBeTruthy();
    expect(ready!.data!.stage).toBe("work");
  });
});

// ── dispatch ───────────────────────────────────────────────────────────────

describe("core lifecycle: dispatch", async () => {
  it("transitions session to running with tmux", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-dispatch-test",
      flow: "bare",
    });
    sessionIds.push(session.id);
    expect(session.status).toBe("ready");

    const result = await app.dispatchService.dispatch(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("ark-");

    const dispatched = await app.sessions.get(session.id)!;
    expect(dispatched.status).toBe("running");
    expect(dispatched.session_id).toBeTruthy();
    expect(dispatched.agent).toBeTruthy();

    // Verify tmux session exists
    expect(sessionExists(dispatched.session_id!)).toBe(true);

    // Clean up tmux
    await app.sessionLifecycle.stop(session.id);
  }, 30_000);

  it("rejects dispatch on non-ready session", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-reject-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch once
    await app.dispatchService.dispatch(session.id);
    const s = await app.sessions.get(session.id)!;
    if (s.session_id) {
      // Dispatch again - should say already running
      const result2 = await app.dispatchService.dispatch(session.id);
      expect(result2.message).toContain("Already running");
    }

    await app.sessionLifecycle.stop(session.id);
  }, 30_000);

  it("returns error for nonexistent session", async () => {
    const result = await app.dispatchService.dispatch("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });
});

// ── getOutput ──────────────────────────────────────────────────────────────

describe("core lifecycle: getOutput", async () => {
  it("returns string for running session (may be empty initially)", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-output-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    await app.dispatchService.dispatch(session.id);

    // getOutput should return a string (possibly empty right after dispatch)
    const output = await getOutput(app, session.id, { lines: 10 });
    expect(typeof output).toBe("string");

    await app.sessionLifecycle.stop(session.id);
  }, 30_000);

  it("returns empty string for session without tmux", async () => {
    const session = await app.sessionLifecycle.start({
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

describe("core lifecycle: stop", async () => {
  it("transitions running session to stopped", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-stop-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    await app.dispatchService.dispatch(session.id);
    const dispatched = await app.sessions.get(session.id)!;
    expect(dispatched.status).toBe("running");

    const result = await app.sessionLifecycle.stop(session.id);
    expect(result.ok).toBe(true);

    const stopped = await app.sessions.get(session.id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.error).toBeNull();
    expect(stopped.session_id).toBeNull();

    // Verify tmux is dead
    expect(sessionExists(dispatched.session_id!)).toBe(false);

    // Verify stop event logged
    const events = await app.events.list(session.id, { type: "session_stopped" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ── resume ─────────────────────────────────────────────────────────────────

describe("core lifecycle: resume", async () => {
  it("re-dispatches a stopped session", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-resume-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch, then stop
    await app.dispatchService.dispatch(session.id);
    await app.sessionLifecycle.stop(session.id);

    const stopped = await app.sessions.get(session.id)!;
    expect(stopped.status).toBe("stopped");

    // Resume
    const result = await app.dispatchService.resume(session.id);
    expect(result.ok).toBe(true);

    const resumed = await app.sessions.get(session.id)!;
    expect(resumed.status).toBe("running");
    expect(resumed.session_id).toBeTruthy();

    // Verify resume event
    const events = await app.events.list(session.id, { type: "session_resumed" });
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Clean up
    await app.sessionLifecycle.stop(session.id);
  }, 30_000);
});

// ── complete ───────────────────────────────────────────────────────────────

describe("core lifecycle: complete", async () => {
  it("advances flow when completing a stage", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-complete-test",
      flow: "bare",
    });
    sessionIds.push(session.id);

    // Dispatch so it's running
    await app.dispatchService.dispatch(session.id);

    // Complete the current stage
    const result = await app.stageAdvance.complete(session.id);
    expect(result.ok).toBe(true);

    const completed = await app.sessions.get(session.id)!;
    // "bare" flow has only one stage ("work"), so completing it
    // should complete the entire flow
    expect(completed.status).toBe("completed");

    // Verify stage_completed event
    const events = await app.events.list(session.id, { type: "stage_completed" });
    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

// ── deleteSession ──────────────────────────────────────────────────────────

describe("core lifecycle: deleteSession", async () => {
  it("removes session and its events from the database", async () => {
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-delete-test",
      flow: "bare",
    });
    // Don't add to sessionIds since we're deleting manually

    // Verify it exists
    expect(await app.sessions.get(session.id)).not.toBeNull();
    expect((await app.events.list(session.id)).length).toBeGreaterThan(0);

    // Delete
    const deleted = await app.sessions.delete(session.id);
    expect(deleted).toBe(true);

    // Verify it's gone
    expect(await app.sessions.get(session.id)).toBeNull();
    expect((await app.events.list(session.id)).length).toBe(0);
  });

  it("returns false for nonexistent session", async () => {
    const deleted = await app.sessions.delete("s-nonexistent");
    expect(deleted).toBe(false);
  });
});

// ── Full round-trip ────────────────────────────────────────────────────────

describe("core lifecycle: full round-trip", async () => {
  it("start -> dispatch -> stop -> resume -> complete -> delete", async () => {
    // 1. Start
    const session = await app.sessionLifecycle.start({
      repo: process.cwd(),
      summary: "lifecycle-roundtrip",
      flow: "bare",
    });
    sessionIds.push(session.id);
    expect(session.status).toBe("ready");

    // 2. Dispatch
    await app.dispatchService.dispatch(session.id);
    expect((await app.sessions.get(session.id))!.status).toBe("running");

    // 3. Stop
    await app.sessionLifecycle.stop(session.id);
    expect((await app.sessions.get(session.id))!.status).toBe("stopped");

    // 4. Resume (re-dispatches)
    await app.dispatchService.resume(session.id);
    expect((await app.sessions.get(session.id))!.status).toBe("running");

    // 5. Complete (advances flow)
    await app.stageAdvance.complete(session.id);
    expect((await app.sessions.get(session.id))!.status).toBe("completed");

    // 6. Delete
    const idx = sessionIds.indexOf(session.id);
    if (idx >= 0) sessionIds.splice(idx, 1);
    const deleted = await app.sessions.delete(session.id);
    expect(deleted).toBe(true);
    expect(await app.sessions.get(session.id)).toBeNull();
  }, 45_000);
});
