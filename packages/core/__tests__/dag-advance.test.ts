import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { AppContext, setApp, clearApp } from "../app.js";
import { advance } from "../services/session-orchestration.js";
import { getApp } from "../app.js";

let app: AppContext;
let dagFlowPath: string;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);

  // Write a minimal DAG flow to the test ARK_DIR so flowUsesDAG() detects it
  const flowsDir = join(getApp().config.arkDir, "flows");
  mkdirSync(flowsDir, { recursive: true });
  dagFlowPath = join(flowsDir, "test-dag.yaml");
  writeFileSync(dagFlowPath, `
name: test-dag
description: Test DAG flow with depends_on
stages:
  - name: plan
    agent: planner
    gate: auto
  - name: implement
    agent: implementer
    gate: auto
    depends_on: [plan]
  - name: review
    agent: reviewer
    gate: auto
    depends_on: [implement]
`);
});

afterAll(async () => {
  if (dagFlowPath && existsSync(dagFlowPath)) rmSync(dagFlowPath);
  await app?.shutdown();
  clearApp();
});

describe("DAG-based advance", () => {
  test("DAG flow: advance to next stage after first stage completes", async () => {
    const s = app.sessions.create({ summary: "Test DAG advance", flow: "test-dag" });
    app.sessions.update(s.id, { stage: "plan", status: "ready" });

    const result = await advance(app, s.id, true); // force=true to bypass gate
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(s.id);
    // After plan completes, implement should be next (it depends on plan)
    expect(updated!.stage).toBe("implement");
    expect(updated!.status).toBe("ready");
  });

  test("DAG flow: advance completes flow when last stage done", async () => {
    const s = app.sessions.create({ summary: "Test DAG completion", flow: "test-dag" });
    app.sessions.update(s.id, { stage: "review", status: "ready" });
    // Log stage_advance events so getCompletedStages picks them up
    app.events.log(s.id, "stage_advance", { actor: "system", data: { from: "plan", to: "implement" } });
    app.events.log(s.id, "stage_advance", { actor: "system", data: { from: "implement", to: "review" } });

    const result = await advance(app, s.id, true); // force=true to bypass gate
    expect(result.ok).toBe(true);

    const updated = app.sessions.get(s.id);
    expect(updated!.status).toBe("completed");
  });

  test("linear flow (quick) advances to next stage", async () => {
    const s = app.sessions.create({ summary: "Test linear quick flow", flow: "quick" });
    app.sessions.update(s.id, { stage: "implement", status: "ready" });

    const result = await advance(app, s.id, true); // force=true to bypass gate
    expect(result.ok).toBe(true);
    const updated = app.sessions.get(s.id);
    // implement -> pr is the next linear stage in quick flow
    expect(updated!.stage).toBe("pr");
  });

  test("linear flow (quick) completes when last stage done", async () => {
    const s = app.sessions.create({ summary: "Test linear completion", flow: "quick" });
    app.sessions.update(s.id, { stage: "merge", status: "ready" });

    const result = await advance(app, s.id, true); // force=true, merge is the last stage
    expect(result.ok).toBe(true);
    const updated = app.sessions.get(s.id);
    expect(updated!.status).toBe("completed");
  });
});
