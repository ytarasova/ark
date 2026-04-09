import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { fanOut, checkAutoJoin, spawnSubagent } from "../services/session-orchestration.js";
import { getReadyStages, getStages, validateDAG } from "../flow.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("fan-out E2E", () => {
  test("full lifecycle: create parent, fan-out, complete children, auto-join", async () => {
    // 1. Create parent
    const parent = app.sessions.create({ summary: "E2E fan-out test", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    // 2. Fan out into 3 children
    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "Task A" }, { summary: "Task B" }, { summary: "Task C" }],
    });
    expect(result.ok).toBe(true);
    expect(result.childIds).toHaveLength(3);

    // 3. Verify parent is waiting
    let parentState = app.sessions.get(parent.id);
    expect(parentState!.status).toBe("waiting");

    // 4. Verify children have parent_id and fork_group
    for (const childId of result.childIds!) {
      const child = app.sessions.get(childId);
      expect(child!.parent_id).toBe(parent.id);
      expect(child!.fork_group).toBeTruthy();
    }

    // 5. Complete children one by one -- auto-join only when ALL done
    app.sessions.update(result.childIds![0], { status: "completed" });
    let joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(false);

    app.sessions.update(result.childIds![1], { status: "completed" });
    joined = await checkAutoJoin(app, result.childIds![1]);
    expect(joined).toBe(false);

    app.sessions.update(result.childIds![2], { status: "completed" });
    joined = await checkAutoJoin(app, result.childIds![2]);
    expect(joined).toBe(true);

    // 6. Verify parent advanced
    parentState = app.sessions.get(parent.id);
    expect(parentState!.status).not.toBe("waiting");
  });

  test("spawn creates child with correct parent linkage", () => {
    const parent = app.sessions.create({ summary: "Spawn test", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = spawnSubagent(app, parent.id, { task: "Child task" });
    expect(result.ok).toBe(true);

    const child = app.sessions.get(result.sessionId!);
    expect(child!.parent_id).toBe(parent.id);
  });

  test("DAG flow validation passes for dag-parallel", () => {
    const stages = getStages("dag-parallel");
    expect(() => validateDAG(stages)).not.toThrow();
  });

  test("DAG flow ready stages resolve correctly through all phases", () => {
    const stages = getStages("dag-parallel");

    // Initially only plan is ready
    const ready0 = getReadyStages(stages, []);
    expect(ready0.map((s) => s.name)).toEqual(["plan"]);

    // After plan, implement + test are parallel-ready
    const ready1 = getReadyStages(stages, ["plan"]);
    expect(ready1.map((s) => s.name).sort()).toEqual(["implement", "test"]);

    // After implement only, test is still ready but integrate is not
    const ready2 = getReadyStages(stages, ["plan", "implement"]);
    expect(ready2.map((s) => s.name)).toEqual(["test"]);

    // After both implement and test, integrate is ready
    const ready3 = getReadyStages(stages, ["plan", "implement", "test"]);
    expect(ready3.map((s) => s.name)).toEqual(["integrate"]);

    // After integrate, review is ready
    const ready4 = getReadyStages(stages, ["plan", "implement", "test", "integrate"]);
    expect(ready4.map((s) => s.name)).toEqual(["review"]);

    // After review, pr is ready
    const ready5 = getReadyStages(stages, ["plan", "implement", "test", "integrate", "review"]);
    expect(ready5.map((s) => s.name)).toEqual(["pr"]);

    // After all, nothing is ready
    const ready6 = getReadyStages(stages, ["plan", "implement", "test", "integrate", "review", "pr"]);
    expect(ready6).toEqual([]);
  });

  test("partial failure: parent gets notified when some children fail", async () => {
    const parent = app.sessions.create({ summary: "Partial fail", flow: "bare" });
    app.sessions.update(parent.id, { stage: "implement", status: "running" });

    const result = fanOut(app, parent.id, {
      tasks: [{ summary: "Will pass" }, { summary: "Will fail" }],
    });

    app.sessions.update(result.childIds![0], { status: "completed" });
    app.sessions.update(result.childIds![1], { status: "failed" });

    const joined = await checkAutoJoin(app, result.childIds![0]);
    expect(joined).toBe(true);

    // Check that partial failure event was logged
    const events = app.events.list(parent.id);
    const failEvent = events.find((e) => e.type === "fan_out_partial_failure");
    expect(failEvent).toBeTruthy();
  });
});
