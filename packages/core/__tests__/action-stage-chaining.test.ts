/**
 * Tests for action stage chaining.
 *
 * Validates that consecutive action stages (e.g., create_pr -> auto_merge)
 * chain-execute correctly via mediateStageHandoff() recursive calls.
 *
 * Test coverage:
 * 1. Single action stage chains to completion
 * 2. Consecutive action stages chain-execute
 * 3. Action failure stops chain and sets failed status
 * 4. Action stage followed by agent stage dispatches agent
 * 5. executeAction no longer calls advance internally
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { mediateStageHandoff, executeAction } from "../services/session-orchestration.js";
import { waitFor } from "./test-helpers.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
});

afterEach(async () => {
  // no-op -- beforeEach handles cleanup
});

describe("action stage chaining", () => {
  it("single action stage chains to completion", async () => {
    // Flow: agent -> action:close (last stage)
    app.flows.save("test-single-action", {
      name: "test-single-action",
      stages: [
        { name: "work", agent: "worker", gate: "auto" },
        { name: "finish", action: "close", gate: "auto" },
      ],
    } as any);

    const session = app.sessions.create({ summary: "single action test", flow: "test-single-action" });
    app.sessions.update(session.id, { status: "ready", stage: "work" });

    // Handoff from work -> finish (action:close)
    const result = await mediateStageHandoff(app, session.id, {
      autoDispatch: true,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.toStage).toBe("finish");
    expect(result.dispatched).toBe(true);

    // Wait for async action chain to complete the flow
    await waitFor(
      () => {
        const s = app.sessions.get(session.id);
        return s?.status === "completed";
      },
      { timeout: 5000, message: "Expected session to reach completed status" },
    );

    // Verify action_executed event was logged
    const events = app.events.list(session.id);
    const actionEvents = events.filter((e) => e.type === "action_executed");
    expect(actionEvents.length).toBeGreaterThanOrEqual(1);
    expect(actionEvents.some((e) => e.data?.action === "close")).toBe(true);
  });

  it("consecutive action stages chain-execute", async () => {
    // Flow: agent -> action:close -> action:close (two consecutive actions)
    app.flows.save("test-chain-actions", {
      name: "test-chain-actions",
      stages: [
        { name: "work", agent: "worker", gate: "auto" },
        { name: "step1", action: "close", gate: "auto" },
        { name: "step2", action: "close", gate: "auto" },
      ],
    } as any);

    const session = app.sessions.create({ summary: "chain test", flow: "test-chain-actions" });
    app.sessions.update(session.id, { status: "ready", stage: "work" });

    // Handoff from work -> step1 (action:close)
    const result = await mediateStageHandoff(app, session.id, {
      autoDispatch: true,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.toStage).toBe("step1");
    expect(result.dispatched).toBe(true);

    // Wait for both actions to chain-execute and complete the flow
    await waitFor(
      () => {
        const s = app.sessions.get(session.id);
        return s?.status === "completed";
      },
      { timeout: 5000, message: "Expected session to reach completed after chained actions" },
    );

    // Verify both action_executed events were logged
    const events = app.events.list(session.id);
    const actionEvents = events.filter((e) => e.type === "action_executed");
    expect(actionEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("action failure stops chain and sets failed status", async () => {
    // Flow: agent -> action:create_pr -> action:auto_merge
    // create_pr will fail because session has no workdir/repo
    app.flows.save("test-fail-chain", {
      name: "test-fail-chain",
      stages: [
        { name: "work", agent: "worker", gate: "auto" },
        { name: "pr", action: "create_pr", gate: "auto" },
        { name: "merge", action: "auto_merge", gate: "auto" },
      ],
    } as any);

    const session = app.sessions.create({ summary: "fail chain test", flow: "test-fail-chain" });
    app.sessions.update(session.id, { status: "ready", stage: "work" });

    // Handoff from work -> pr (action:create_pr, will fail)
    const result = await mediateStageHandoff(app, session.id, {
      autoDispatch: true,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.toStage).toBe("pr");
    expect(result.dispatched).toBe(true);

    // Wait for the failure to propagate
    await waitFor(
      () => {
        const s = app.sessions.get(session.id);
        return s?.status === "failed";
      },
      { timeout: 5000, message: "Expected session to reach failed status" },
    );

    const updated = app.sessions.get(session.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("create_pr");

    // Verify auto_merge was NOT executed
    const events = app.events.list(session.id);
    const mergeEvents = events.filter((e) => e.type === "action_executed" && e.data?.action === "auto_merge");
    expect(mergeEvents.length).toBe(0);
  });

  it("action stage followed by agent stage dispatches agent", async () => {
    // Flow: agent1 -> action:close -> agent2
    app.flows.save("test-action-then-agent", {
      name: "test-action-then-agent",
      stages: [
        { name: "work1", agent: "worker", gate: "auto" },
        { name: "middle", action: "close", gate: "auto" },
        { name: "work2", agent: "worker", gate: "auto" },
      ],
    } as any);

    const session = app.sessions.create({ summary: "action then agent test", flow: "test-action-then-agent" });
    app.sessions.update(session.id, { status: "ready", stage: "work1" });

    // Handoff from work1 -> middle (action:close)
    const result = await mediateStageHandoff(app, session.id, {
      autoDispatch: true,
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.toStage).toBe("middle");
    expect(result.dispatched).toBe(true);

    // Wait for the action to execute and advance to work2
    await waitFor(
      () => {
        const s = app.sessions.get(session.id);
        return s?.stage === "work2";
      },
      { timeout: 5000, message: "Expected session to advance to work2 stage" },
    );

    // Verify session is at work2 with ready status (dispatch will fail in test but stage should advance)
    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("work2");

    // Verify the close action was executed
    const events = app.events.list(session.id);
    const actionEvents = events.filter((e) => e.type === "action_executed" && e.data?.action === "close");
    expect(actionEvents.length).toBe(1);
  });

  it("executeAction no longer calls advance internally", async () => {
    // Set up session at an action stage
    app.flows.save("test-no-advance", {
      name: "test-no-advance",
      stages: [
        { name: "work", agent: "worker", gate: "auto" },
        { name: "finish", action: "close", gate: "auto" },
        { name: "after", agent: "worker", gate: "auto" },
      ],
    } as any);

    const session = app.sessions.create({ summary: "no advance test", flow: "test-no-advance" });
    app.sessions.update(session.id, { status: "ready", stage: "finish" });

    // Call executeAction directly
    const result = await executeAction(app, session.id, "close");

    expect(result.ok).toBe(true);
    expect(result.message).toContain("close");

    // Session stage should remain at "finish" -- executeAction no longer advances
    const updated = app.sessions.get(session.id);
    expect(updated?.stage).toBe("finish");
  });
});
