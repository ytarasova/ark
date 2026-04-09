import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext, setApp, clearApp } from "../app.js";
import { getStages, getStage, validateDAG } from "../flow.js";

let app: AppContext;
beforeAll(async () => { app = AppContext.forTest(); await app.boot(); setApp(app); });
afterAll(async () => { await app?.shutdown(); clearApp(); });

describe("dag-parallel flow", () => {
  test("loads with correct stages", () => {
    const stages = getStages("dag-parallel");
    expect(stages).toHaveLength(6);
    expect(stages.map((s) => s.name)).toEqual(["plan", "implement", "test", "integrate", "review", "pr"]);
  });

  test("implement and test depend on plan", () => {
    const impl = getStage("dag-parallel", "implement");
    const testStage = getStage("dag-parallel", "test");
    expect(impl?.depends_on).toEqual(["plan"]);
    expect(testStage?.depends_on).toEqual(["plan"]);
  });

  test("integrate depends on both implement and test", () => {
    const integrate = getStage("dag-parallel", "integrate");
    expect(integrate?.depends_on).toEqual(["implement", "test"]);
  });

  test("DAG is valid (no cycles)", () => {
    const stages = getStages("dag-parallel");
    expect(() => validateDAG(stages)).not.toThrow();
  });
});
