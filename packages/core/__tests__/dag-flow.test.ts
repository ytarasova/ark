import { describe, test, expect } from "bun:test";
import { getReadyStages, validateDAG } from "../state/flow.js";
import type { StageDefinition } from "../state/flow.js";

describe("DAG flow resolution", () => {
  const stages: StageDefinition[] = [
    { name: "plan", agent: "planner", gate: "auto" },
    { name: "impl-api", agent: "implementer", gate: "auto", depends_on: ["plan"] },
    { name: "impl-ui", agent: "implementer", gate: "auto", depends_on: ["plan"] },
    { name: "integrate", agent: "implementer", gate: "auto", depends_on: ["impl-api", "impl-ui"] },
    { name: "review", agent: "reviewer", gate: "auto", depends_on: ["integrate"] },
  ];

  test("first stage has no dependencies", () => {
    const ready = getReadyStages(stages, []);
    expect(ready.map((s) => s.name)).toEqual(["plan"]);
  });

  test("parallel stages become ready when dependency completes", () => {
    const ready = getReadyStages(stages, ["plan"]);
    expect(ready.map((s) => s.name).sort()).toEqual(["impl-api", "impl-ui"]);
  });

  test("merge stage waits for all dependencies", () => {
    const ready = getReadyStages(stages, ["plan", "impl-api"]);
    // impl-ui is ready (depends only on plan), but integrate is not (needs both impl-api and impl-ui)
    expect(ready.map((s) => s.name)).toEqual(["impl-ui"]);
  });

  test("merge stage ready when all deps done", () => {
    const ready = getReadyStages(stages, ["plan", "impl-api", "impl-ui"]);
    expect(ready.map((s) => s.name)).toEqual(["integrate"]);
  });

  test("validateDAG detects cycles", () => {
    const cyclic: StageDefinition[] = [
      { name: "a", agent: "x", gate: "auto", depends_on: ["b"] },
      { name: "b", agent: "x", gate: "auto", depends_on: ["a"] },
    ];
    expect(() => validateDAG(cyclic)).toThrow("cycle");
  });

  test("linear stages without depends_on default to sequential", () => {
    const linear: StageDefinition[] = [
      { name: "plan", agent: "planner", gate: "auto" },
      { name: "implement", agent: "implementer", gate: "auto" },
      { name: "review", agent: "reviewer", gate: "auto" },
    ];
    const ready0 = getReadyStages(linear, []);
    expect(ready0.map((s) => s.name)).toEqual(["plan"]);

    const ready1 = getReadyStages(linear, ["plan"]);
    expect(ready1.map((s) => s.name)).toEqual(["implement"]);
  });
});
