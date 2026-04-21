import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { AppContext } from "../app.js";
import { advance } from "../services/session-orchestration.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;
let dagFlowPath: string;
let parallelFlowPath: string;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);

  // Write a minimal DAG flow to the test ARK_DIR so flowUsesDAG() detects it
  const flowsDir = join(getApp().config.arkDir, "flows");
  mkdirSync(flowsDir, { recursive: true });
  dagFlowPath = join(flowsDir, "test-dag.yaml");
  writeFileSync(
    dagFlowPath,
    `
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
`,
  );

  // Write a parallel DAG flow for fan-out / join testing
  parallelFlowPath = join(flowsDir, "test-dag-parallel.yaml");
  writeFileSync(
    parallelFlowPath,
    `
name: test-dag-parallel
description: Test parallel DAG with fan-out and join
stages:
  - name: plan
    agent: planner
    gate: auto
  - name: implement
    agent: implementer
    gate: auto
    depends_on: [plan]
  - name: test
    agent: tester
    gate: auto
    depends_on: [plan]
  - name: integrate
    agent: implementer
    gate: auto
    depends_on: [implement, test]
`,
  );
});

afterAll(async () => {
  if (dagFlowPath && existsSync(dagFlowPath)) rmSync(dagFlowPath);
  if (parallelFlowPath && existsSync(parallelFlowPath)) rmSync(parallelFlowPath);
  await app?.shutdown();
  clearApp();
});

describe("DAG-based advance", async () => {
  test("DAG flow: advance to next stage after first stage completes", async () => {
    const s = await app.sessions.create({ summary: "Test DAG advance", flow: "test-dag" });
    await app.sessions.update(s.id, { stage: "plan", status: "ready" });

    const result = await advance(app, s.id, true); // force=true to bypass gate
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(s.id);
    // After plan completes, implement should be next (it depends on plan)
    expect(updated!.stage).toBe("implement");
    expect(updated!.status).toBe("ready");
  });

  test("DAG flow: advance completes flow when last stage done", async () => {
    const s = await app.sessions.create({ summary: "Test DAG completion", flow: "test-dag" });
    await app.sessions.update(s.id, { stage: "review", status: "ready" });
    // Log stage_advance events so getCompletedStages picks them up
    await app.events.log(s.id, "stage_advance", { actor: "system", data: { from: "plan", to: "implement" } });
    await app.events.log(s.id, "stage_advance", { actor: "system", data: { from: "implement", to: "review" } });

    const result = await advance(app, s.id, true); // force=true to bypass gate
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(s.id);
    expect(updated!.status).toBe("completed");
  });

  test("linear flow (quick) advances to next stage", async () => {
    const s = await app.sessions.create({ summary: "Test linear quick flow", flow: "quick" });
    await app.sessions.update(s.id, { stage: "implement", status: "ready" });

    const result = await advance(app, s.id, true);
    expect(result.ok).toBe(true);
    const updated = await app.sessions.get(s.id);
    // implement -> verify is the next stage in quick flow
    expect(updated!.stage).toBe("verify");
  });

  test("linear flow (quick) completes when last stage done", async () => {
    const s = await app.sessions.create({ summary: "Test linear completion", flow: "quick" });
    await app.sessions.update(s.id, { stage: "merge", status: "ready" });

    const result = await advance(app, s.id, true);
    expect(result.ok).toBe(true);
    const updated = await app.sessions.get(s.id);
    expect(updated!.status).toBe("completed");
  });
});

describe("Parallel DAG advance via depends_on", async () => {
  test("advance from plan moves to first ready parallel stage", async () => {
    const s = await app.sessions.create({ summary: "Test parallel DAG", flow: "test-dag-parallel" });
    await app.sessions.update(s.id, { stage: "plan", status: "ready" });

    const result = await advance(app, s.id, true);
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(s.id);
    // Should advance to one of the parallel stages (implement or test)
    expect(["implement", "test"]).toContain(updated!.stage);
    expect(updated!.status).toBe("ready");

    // Flow state should show plan as completed
    const flowState = await app.flowStates.load(s.id);
    expect(flowState).not.toBeNull();
    expect(flowState!.completedStages).toContain("plan");
  });

  test("join barrier blocks integrate until both parallel stages complete", async () => {
    const s = await app.sessions.create({ summary: "Test join barrier", flow: "test-dag-parallel" });
    await app.sessions.update(s.id, { stage: "implement", status: "ready" });

    // Mark plan as completed in flow state (it ran before implement)
    await app.flowStates.markStageCompleted(s.id, "plan");

    const result = await advance(app, s.id, true);
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(s.id);
    // integrate requires both implement AND test to complete
    // test is not yet done, so integrate is blocked
    // session should be waiting (join barrier) or advance to test
    // The behavior depends on whether test is seen as a successor --
    // implement has no edge to test, so they're siblings, not sequential
    expect(updated!.status).toBe("waiting");
  });

  test("integrate becomes ready after both parallel stages complete", async () => {
    const s = await app.sessions.create({ summary: "Test join complete", flow: "test-dag-parallel" });
    await app.sessions.update(s.id, { stage: "test", status: "ready" });

    // Mark plan and implement as completed in flow state
    await app.flowStates.markStageCompleted(s.id, "plan");
    await app.flowStates.markStageCompleted(s.id, "implement");

    const result = await advance(app, s.id, true);
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(s.id);
    expect(updated!.stage).toBe("integrate");
    expect(updated!.status).toBe("ready");
  });

  test("parallel DAG flow completes when last stage done", async () => {
    const s = await app.sessions.create({ summary: "Test parallel completion", flow: "test-dag-parallel" });
    await app.sessions.update(s.id, { stage: "integrate", status: "ready" });

    // Mark all preceding stages as completed
    await app.flowStates.markStageCompleted(s.id, "plan");
    await app.flowStates.markStageCompleted(s.id, "implement");
    await app.flowStates.markStageCompleted(s.id, "test");

    const result = await advance(app, s.id, true);
    expect(result.ok).toBe(true);

    const updated = await app.sessions.get(s.id);
    expect(updated!.status).toBe("completed");
  });
});
