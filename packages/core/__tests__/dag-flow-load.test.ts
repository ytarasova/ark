import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AppContext } from "../app.js";
import { getStages, getStage, validateDAG } from "../services/flow.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

describe("dag-parallel flow", () => {
  test("loads with correct stages", () => {
    const stages = getStages(app, "dag-parallel");
    expect(stages).toHaveLength(6);
    expect(stages.map((s) => s.name)).toEqual(["plan", "implement", "test", "integrate", "review", "pr"]);
  });

  test("implement and test depend on plan", () => {
    const impl = getStage(app, "dag-parallel", "implement");
    const testStage = getStage(app, "dag-parallel", "test");
    expect(impl?.depends_on).toEqual(["plan"]);
    expect(testStage?.depends_on).toEqual(["plan"]);
  });

  test("integrate depends on both implement and test", () => {
    const integrate = getStage(app, "dag-parallel", "integrate");
    expect(integrate?.depends_on).toEqual(["implement", "test"]);
  });

  test("DAG is valid (no cycles)", () => {
    const stages = getStages(app, "dag-parallel");
    expect(() => validateDAG(stages)).not.toThrow();
  });
});
