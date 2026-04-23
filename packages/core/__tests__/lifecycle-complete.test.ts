/**
 * Focused tests for stageAdvance.complete() -- the primary API for marking
 * a session's current stage as done and cascading into the next stage.
 *
 * Validates:
 *   - Non-existent session returns an error.
 *   - Verification gate blocks completion when open todos exist.
 *   - force: true bypasses todo verification.
 *   - Single-stage flow (bare) completes the entire flow.
 *   - Multi-stage flow (quick) cascades advance to the next stage.
 *   - Proper events are logged (stage_completed, session_completed, stage_ready).
 *   - Messages are marked read on completion.
 *   - session_id (tmux handle) is cleared after complete.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  if (app) await app.shutdown();
});

// ── Error paths ─────────────────────────────────────────────────────────────

describe("stageAdvance.complete() error paths", () => {
  it("returns error for nonexistent session", async () => {
    const result = await app.stageAdvance.complete("s-nonexistent");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not found");
  });

  it("blocks completion when open todos exist", async () => {
    const session = await app.sessions.create({ summary: "todo-block test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    await app.todos.add(session.id, "Unfinished task");

    const result = await app.stageAdvance.complete(session.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Verification failed");
  });

  it("force: true bypasses todo verification", async () => {
    const session = await app.sessions.create({ summary: "force-bypass test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    await app.todos.add(session.id, "Unfinished task");

    const result = await app.stageAdvance.complete(session.id, { force: true });
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });
});

// ── Single-stage flow (bare) ────────────────────────────────────────────────

describe("stageAdvance.complete() on single-stage flow (bare)", () => {
  it("completes the entire flow", async () => {
    const session = await app.sessionLifecycle.start({
      summary: "bare-complete",
      flow: "bare",
      repo: process.cwd(),
    });
    await app.sessions.update(session.id, { status: "running" });

    const result = await app.stageAdvance.complete(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("completed");

    const updated = await app.sessions.get(session.id);
    expect(updated?.status).toBe("completed");
  });

  it("clears session_id (tmux handle) after completion", async () => {
    const session = await app.sessions.create({ summary: "clear-handle", flow: "bare" });
    await app.sessions.update(session.id, {
      status: "running",
      stage: "work",
      session_id: "ark-s-fake-tmux",
    });

    await app.stageAdvance.complete(session.id);

    const updated = await app.sessions.get(session.id);
    expect(updated?.session_id).toBeNull();
  });

  it("logs stage_completed and session_completed events", async () => {
    const session = await app.sessions.create({ summary: "events-test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    await app.stageAdvance.complete(session.id);

    const allEvents = await app.events.list(session.id);
    const stageCompleted = allEvents.find((e) => e.type === "stage_completed");
    expect(stageCompleted).toBeTruthy();
    expect(stageCompleted!.stage).toBe("work");

    const sessionCompleted = allEvents.find((e) => e.type === "session_completed");
    expect(sessionCompleted).toBeTruthy();
    expect(sessionCompleted!.data?.final_stage).toBe("work");
  });

  it("marks messages as read", async () => {
    const session = await app.sessions.create({ summary: "mark-read test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    await app.messages.send(session.id, "agent", "progress update", "info");
    const before = await app.messages.list(session.id);
    expect(before.length).toBe(1);

    await app.stageAdvance.complete(session.id);

    const unreadCount = await app.messages.unreadCount(session.id);
    expect(unreadCount).toBe(0);
  });
});

// ── Multi-stage flow (quick) ────────────────────────────────────────────────

describe("stageAdvance.complete() on multi-stage flow (quick)", () => {
  it("advances to the next stage instead of completing the flow", async () => {
    const session = await app.sessionLifecycle.start({
      summary: "quick-advance",
      flow: "quick",
      repo: process.cwd(),
    });
    await app.sessions.update(session.id, { status: "running" });

    const beforeStage = (await app.sessions.get(session.id))!.stage;
    expect(beforeStage).toBe("implement");

    const result = await app.stageAdvance.complete(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("verify");

    const updated = await app.sessions.get(session.id);
    expect(updated?.stage).toBe("verify");
    expect(updated?.status).toBe("ready");
  });

  it("logs stage_ready event with from/to stage data", async () => {
    const session = await app.sessionLifecycle.start({
      summary: "quick-events",
      flow: "quick",
      repo: process.cwd(),
    });
    await app.sessions.update(session.id, { status: "running" });

    await app.stageAdvance.complete(session.id);

    const allEvents = await app.events.list(session.id);
    const stageReady = allEvents.filter((e) => e.type === "stage_ready");
    const advanceEvent = stageReady.find((e) => e.data?.from_stage === "implement" && e.data?.to_stage === "verify");
    expect(advanceEvent).toBeTruthy();
  });

  it("walks through all stages to flow completion", async () => {
    const session = await app.sessionLifecycle.start({
      summary: "quick-full",
      flow: "quick",
      repo: process.cwd(),
    });

    // implement -> verify
    await app.sessions.update(session.id, { status: "running" });
    let result = await app.stageAdvance.complete(session.id);
    expect(result.ok).toBe(true);
    expect((await app.sessions.get(session.id))?.stage).toBe("verify");

    // verify -> pr
    await app.sessions.update(session.id, { status: "running" });
    result = await app.stageAdvance.complete(session.id);
    expect(result.ok).toBe(true);
    expect((await app.sessions.get(session.id))?.stage).toBe("pr");

    // pr -> merge
    await app.sessions.update(session.id, { status: "running" });
    result = await app.stageAdvance.complete(session.id);
    expect(result.ok).toBe(true);
    expect((await app.sessions.get(session.id))?.stage).toBe("merge");

    // merge -> completed (last stage)
    await app.sessions.update(session.id, { status: "running" });
    result = await app.stageAdvance.complete(session.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("completed");

    const final = await app.sessions.get(session.id);
    expect(final?.status).toBe("completed");
  });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe("stageAdvance.complete() idempotency", () => {
  it("second call with same key returns cached result without re-running", async () => {
    const session = await app.sessions.create({ summary: "idemp-test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const key = "test-key-" + Date.now();
    const r1 = await app.stageAdvance.complete(session.id, { idempotencyKey: key });
    expect(r1.ok).toBe(true);

    // Session already completed; a naive re-run would fail with "not found" or
    // wrong state, but the keyed replay returns the cached result.
    const r2 = await app.stageAdvance.complete(session.id, { idempotencyKey: key });
    expect(r2.ok).toBe(true);
    expect(r2.message).toBe(r1.message);
  });

  it("without key, each call runs the body independently", async () => {
    const session = await app.sessions.create({ summary: "no-key test", flow: "bare" });
    await app.sessions.update(session.id, { status: "running", stage: "work" });

    const r1 = await app.stageAdvance.complete(session.id);
    expect(r1.ok).toBe(true);

    // Second call without key re-runs the body. complete() doesn't guard
    // against already-completed sessions -- it re-completes and re-advances.
    const r2 = await app.stageAdvance.complete(session.id);
    expect(r2.ok).toBe(true);

    // Both calls produced stage_completed events
    const events = await app.events.list(session.id, { type: "stage_completed" });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});
