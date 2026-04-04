import { describe, it, expect } from "bun:test";
import { parseGraphFlow, getSuccessors, getPredecessors, isJoinNode, isFanOutNode, topologicalSort, validateGraphFlow } from "../graph-flow.js";

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
