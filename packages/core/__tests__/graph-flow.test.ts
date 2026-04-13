import { describe, it, expect } from "bun:test";
import { parseGraphFlow, getSuccessors, getPredecessors, isJoinNode, isFanOutNode, topologicalSort, validateGraphFlow, resolveNextStages } from "../state/graph-flow.js";

describe("graph flow", () => {
  const flow = parseGraphFlow({
    name: "test-flow",
    nodes: [
      { name: "plan", agent: "planner" },
      { name: "impl-a", agent: "implementer" },
      { name: "impl-b", agent: "implementer" },
      { name: "review", agent: "reviewer" },
    ],
    edges: [
      { from: "plan", to: "impl-a" },
      { from: "plan", to: "impl-b" },
      { from: "impl-a", to: "review" },
      { from: "impl-b", to: "review" },
    ],
  });

  it("parses nodes and edges", () => {
    expect(flow.nodes).toHaveLength(4);
    expect(flow.edges).toHaveLength(4);
  });

  it("detects entrypoints", () => {
    expect(flow.entrypoints).toEqual(["plan"]);
  });

  it("getSuccessors returns outgoing nodes", () => {
    expect(getSuccessors(flow, "plan")).toEqual(["impl-a", "impl-b"]);
  });

  it("getPredecessors returns incoming nodes", () => {
    expect(getPredecessors(flow, "review")).toEqual(["impl-a", "impl-b"]);
  });

  it("detects fan-out nodes", () => {
    expect(isFanOutNode(flow, "plan")).toBe(true);
    expect(isFanOutNode(flow, "impl-a")).toBe(false);
  });

  it("detects join nodes", () => {
    expect(isJoinNode(flow, "review")).toBe(true);
    expect(isJoinNode(flow, "plan")).toBe(false);
  });

  it("topological sort produces valid ordering", () => {
    const sorted = topologicalSort(flow);
    expect(sorted).toHaveLength(4);
    expect(sorted.indexOf("plan")).toBeLessThan(sorted.indexOf("impl-a"));
    expect(sorted.indexOf("plan")).toBeLessThan(sorted.indexOf("impl-b"));
    expect(sorted.indexOf("impl-a")).toBeLessThan(sorted.indexOf("review"));
  });

  it("validates valid flow", () => {
    const result = validateGraphFlow(flow);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("detects missing node references", () => {
    const bad = parseGraphFlow({
      name: "bad", nodes: [{ name: "a", agent: "x" }],
      edges: [{ from: "a", to: "nonexistent" }],
    });
    const result = validateGraphFlow(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("nonexistent"))).toBe(true);
  });

  it("auto-generates linear edges when no edges specified", () => {
    const linear = parseGraphFlow({
      name: "linear",
      nodes: [{ name: "a", agent: "x" }, { name: "b", agent: "y" }, { name: "c", agent: "z" }],
    });
    expect(linear.edges).toHaveLength(2);
    expect(linear.edges[0]).toEqual({ from: "a", to: "b" });
  });

  it("evaluates conditional edges", () => {
    const conditional = parseGraphFlow({
      name: "cond",
      nodes: [{ name: "check", agent: "x" }, { name: "pass", agent: "y" }, { name: "fail", agent: "z" }],
      edges: [
        { from: "check", to: "pass", condition: "session.status === 'approved'" },
        { from: "check", to: "fail", condition: "session.status !== 'approved'" },
      ],
    });
    expect(getSuccessors(conditional, "check", { status: "approved" })).toEqual(["pass"]);
    expect(getSuccessors(conditional, "check", { status: "rejected" })).toEqual(["fail"]);
  });
});

describe("depends_on edge synthesis", () => {
  it("creates correct edges from depends_on", () => {
    const flow = parseGraphFlow({
      name: "deps-flow",
      stages: [
        { name: "plan", agent: "planner" },
        { name: "implement", agent: "implementer", depends_on: ["plan"] },
        { name: "review", agent: "reviewer", depends_on: ["implement"] },
      ],
    });
    expect(flow.edges).toHaveLength(2);
    expect(flow.edges).toContainEqual({ from: "plan", to: "implement" });
    expect(flow.edges).toContainEqual({ from: "implement", to: "review" });
  });

  it("creates fan-out edges from depends_on", () => {
    const flow = parseGraphFlow({
      name: "fanout",
      stages: [
        { name: "plan", agent: "planner" },
        { name: "impl", agent: "implementer", depends_on: ["plan"] },
        { name: "test", agent: "tester", depends_on: ["plan"] },
      ],
    });
    expect(flow.edges).toHaveLength(2);
    expect(flow.edges).toContainEqual({ from: "plan", to: "impl" });
    expect(flow.edges).toContainEqual({ from: "plan", to: "test" });
    expect(isFanOutNode(flow, "plan")).toBe(true);
  });

  it("creates join edges from depends_on", () => {
    const flow = parseGraphFlow({
      name: "join",
      stages: [
        { name: "a", agent: "x" },
        { name: "b", agent: "x", depends_on: ["a"] },
        { name: "c", agent: "x", depends_on: ["a"] },
        { name: "d", agent: "x", depends_on: ["b", "c"] },
      ],
    });
    expect(flow.edges).toContainEqual({ from: "b", to: "d" });
    expect(flow.edges).toContainEqual({ from: "c", to: "d" });
    expect(isJoinNode(flow, "d")).toBe(true);
  });

  it("handles mixed depends_on and implicit linear", () => {
    const flow = parseGraphFlow({
      name: "mixed",
      stages: [
        { name: "a", agent: "x" },
        { name: "b", agent: "x", depends_on: ["a"] },
        { name: "c", agent: "x" }, // no depends_on -- implicit linear from b
      ],
    });
    expect(flow.edges).toHaveLength(2);
    expect(flow.edges).toContainEqual({ from: "a", to: "b" });
    expect(flow.edges).toContainEqual({ from: "b", to: "c" });
  });

  it("detects entrypoints correctly with depends_on", () => {
    const flow = parseGraphFlow({
      name: "entry",
      stages: [
        { name: "start", agent: "x" },
        { name: "middle", agent: "x", depends_on: ["start"] },
        { name: "end", agent: "x", depends_on: ["middle"] },
      ],
    });
    expect(flow.entrypoints).toEqual(["start"]);
  });

  it("resolveNextStages works with synthesized edges", () => {
    const flow = parseGraphFlow({
      name: "dag-parallel",
      stages: [
        { name: "plan", agent: "planner" },
        { name: "implement", agent: "implementer", depends_on: ["plan"] },
        { name: "test", agent: "tester", depends_on: ["plan"] },
        { name: "integrate", agent: "implementer", depends_on: ["implement", "test"] },
      ],
    });

    // After plan completes, both implement and test are ready (parallel)
    const afterPlan = resolveNextStages(flow, "plan", {}, []);
    expect(afterPlan).toContain("implement");
    expect(afterPlan).toContain("test");
    expect(afterPlan).toHaveLength(2);

    // After implement completes (but test not done), integrate is NOT ready (join barrier)
    const afterImpl = resolveNextStages(flow, "implement", {}, ["plan"]);
    expect(afterImpl).toEqual([]);

    // After both implement and test complete, integrate IS ready
    const afterBoth = resolveNextStages(flow, "test", {}, ["plan", "implement"]);
    expect(afterBoth).toEqual(["integrate"]);
  });

  it("explicit edges take priority over depends_on", () => {
    const flow = parseGraphFlow({
      name: "explicit",
      stages: [
        { name: "a", agent: "x", depends_on: ["nonexistent"] },
        { name: "b", agent: "x" },
      ],
      edges: [
        { from: "a", to: "b" },
      ],
    });
    // Explicit edges are used, depends_on is ignored
    expect(flow.edges).toHaveLength(1);
    expect(flow.edges[0]).toEqual({ from: "a", to: "b" });
  });
});
