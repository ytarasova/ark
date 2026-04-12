/**
 * Tests for orchestrator-mediated stage handoff (advanceAndDispatch).
 *
 * Validates that the unified advanceAndDispatch function correctly:
 * 1. Runs pre-advance verification when verify=true
 * 2. Advances to the next stage
 * 3. Auto-dispatches agent/fork/action stages
 * 4. Blocks on verification failure
 * 5. Completes the flow when no more stages remain
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { AppContext, setApp, clearApp, getApp } from "../app.js";
import { startSession, advance, advanceAndDispatch } from "../services/session-orchestration.js";

let app: AppContext;
let multiStageFlowPath: string;
let verifyFlowPath: string;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);

  // Write a multi-stage flow (plan -> implement -> pr)
  const flowsDir = join(getApp().config.arkDir, "flows");
  mkdirSync(flowsDir, { recursive: true });
  multiStageFlowPath = join(flowsDir, "test-multi.yaml");
  writeFileSync(multiStageFlowPath, `
name: test-multi
description: Multi-stage test flow
stages:
  - name: plan
    agent: planner
    gate: auto
  - name: implement
    agent: implementer
    gate: auto
  - name: pr
    action: create_pr
    gate: auto
`);

  // Write a flow with verify scripts
  verifyFlowPath = join(flowsDir, "test-verify.yaml");
  writeFileSync(verifyFlowPath, `
name: test-verify
description: Flow with verify scripts
stages:
  - name: implement
    agent: implementer
    gate: auto
    verify:
      - "exit 1"
  - name: review
    agent: reviewer
    gate: auto
`);
});

afterAll(async () => {
  if (multiStageFlowPath && existsSync(multiStageFlowPath)) rmSync(multiStageFlowPath);
  if (verifyFlowPath && existsSync(verifyFlowPath)) rmSync(verifyFlowPath);
  await app?.shutdown();
  clearApp();
});

describe("advanceAndDispatch", () => {
  it("advances to next agent stage and returns dispatched", async () => {
    const s = app.sessions.create({ summary: "Test advance+dispatch", flow: "test-multi" });
    app.sessions.update(s.id, { stage: "plan", status: "ready" });

    const result = await advanceAndDispatch(app, s.id, { verify: false });
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(s.id);
    expect(updated!.stage).toBe("implement");
    // Should attempt to dispatch (fire-and-forget), returning "dispatched"
    expect(result.action).toBe("dispatched");
  });

  it("completes flow when last stage is done", async () => {
    const s = app.sessions.create({ summary: "Test flow completion", flow: "test-multi" });
    app.sessions.update(s.id, { stage: "pr", status: "ready" });

    const result = await advanceAndDispatch(app, s.id, { verify: false });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("completed");

    const updated = app.sessions.get(s.id);
    expect(updated!.status).toBe("completed");
  });

  it("returns advanced when autoDispatch is false", async () => {
    const s = app.sessions.create({ summary: "Test advance only", flow: "test-multi" });
    app.sessions.update(s.id, { stage: "plan", status: "ready" });

    const result = await advanceAndDispatch(app, s.id, { autoDispatch: false, verify: false });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("advanced");

    const updated = app.sessions.get(s.id);
    expect(updated!.stage).toBe("implement");
    expect(updated!.status).toBe("ready");
  });

  it("blocks on verification failure when verify=true", async () => {
    const s = app.sessions.create({ summary: "Test verify block", flow: "test-verify" });
    app.sessions.update(s.id, { stage: "implement", status: "ready" });

    const result = await advanceAndDispatch(app, s.id, { verify: true });
    expect(result.ok).toBe(false);
    expect(result.action).toBe("blocked");

    const updated = app.sessions.get(s.id);
    expect(updated!.status).toBe("blocked");
    expect(updated!.breakpoint_reason).toContain("Verification failed");
  });

  it("skips verification when verify=false", async () => {
    const s = app.sessions.create({ summary: "Test skip verify", flow: "test-verify" });
    app.sessions.update(s.id, { stage: "implement", status: "ready" });

    const result = await advanceAndDispatch(app, s.id, { verify: false });
    expect(result.ok).toBe(true);
    // Should advance past implement -> review without blocking
    expect(result.action).toBe("dispatched");

    const updated = app.sessions.get(s.id);
    expect(updated!.stage).toBe("review");
  });

  it("handles single-stage flow (autonomous) completing", async () => {
    const s = app.sessions.create({ summary: "Test autonomous completion", flow: "autonomous" });
    app.sessions.update(s.id, { stage: "work", status: "ready" });

    const result = await advanceAndDispatch(app, s.id, { verify: false });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("completed");

    const updated = app.sessions.get(s.id);
    expect(updated!.status).toBe("completed");
  });

  it("returns error for nonexistent session", async () => {
    const result = await advanceAndDispatch(app, "s-nonexistent", { verify: false });
    expect(result.ok).toBe(false);
    expect(result.action).toBe("error");
  });

  it("advances to action stage and returns dispatched", async () => {
    // Start at implement stage, advance should move to pr (action: create_pr)
    const s = app.sessions.create({ summary: "Test action dispatch", flow: "test-multi" });
    app.sessions.update(s.id, { stage: "implement", status: "ready" });

    const result = await advanceAndDispatch(app, s.id, { verify: false });
    expect(result.ok).toBe(true);
    expect(result.action).toBe("dispatched");
    expect(result.message).toContain("action");

    const updated = app.sessions.get(s.id);
    expect(updated!.stage).toBe("pr");
  });

  it("defaults verify to true", async () => {
    // Use verify flow -- verify should block by default
    const s = app.sessions.create({ summary: "Test default verify", flow: "test-verify" });
    app.sessions.update(s.id, { stage: "implement", status: "ready" });

    const result = await advanceAndDispatch(app, s.id);
    expect(result.ok).toBe(false);
    expect(result.action).toBe("blocked");
  });

  it("defaults autoDispatch to true", async () => {
    const s = app.sessions.create({ summary: "Test default dispatch", flow: "test-multi" });
    app.sessions.update(s.id, { stage: "plan", status: "ready" });

    const result = await advanceAndDispatch(app, s.id, { verify: false });
    // Should dispatch since autoDispatch defaults to true
    expect(result.action).toBe("dispatched");
  });
});

describe("advanceAndDispatch integration with applyReport", () => {
  it("conductor handleReport path: completed report triggers advance+dispatch", () => {
    // Verify that applyReport still sets shouldAdvance correctly
    // so the conductor can call advanceAndDispatch
    const { applyReport } = require("../services/session-orchestration.js");
    const s = app.sessions.create({ summary: "Integration test", flow: "test-multi" });
    app.sessions.update(s.id, { status: "running", stage: "plan" });

    const result = applyReport(app, s.id, {
      type: "completed",
      stage: "plan",
      summary: "Planning done",
    });

    expect(result.shouldAdvance).toBe(true);
    expect(result.shouldAutoDispatch).toBe(true);
  });
});
