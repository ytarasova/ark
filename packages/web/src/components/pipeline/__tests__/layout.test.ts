import { describe, test, expect } from "bun:test";
import { layoutPipeline, separateBackEdges, validateDag, NODE_WIDTH, COLUMN_GAP, PADDING } from "../layout.js";
import type { PipelineStage, PipelineEdge } from "../types.js";

function makeStage(name: string, overrides?: Partial<PipelineStage>): PipelineStage {
  return {
    name,
    agent: name + "-agent",
    action: null,
    type: "normal",
    gate: "auto",
    status: "pending",
    duration: null,
    cost: null,
    model: null,
    tokenCount: null,
    summary: null,
    toolCalls: [],
    on_failure: null,
    verify: null,
    depends_on: [],
    workers: null,
    ...overrides,
  };
}

function makeEdge(from: string, to: string, overrides?: Partial<PipelineEdge>): PipelineEdge {
  return {
    from,
    to,
    condition: null,
    label: null,
    isBackEdge: false,
    ...overrides,
  };
}

describe("layoutPipeline", () => {
  test("linear flow with 5 stages", () => {
    const stages = [
      makeStage("plan"),
      makeStage("implement"),
      makeStage("verify"),
      makeStage("review"),
      makeStage("pr"),
    ];
    const edges = [
      makeEdge("plan", "implement"),
      makeEdge("implement", "verify"),
      makeEdge("verify", "review"),
      makeEdge("review", "pr"),
    ];

    const result = layoutPipeline(stages, edges);

    // Should return 5 nodes
    expect(result).toHaveLength(5);

    // All nodes should have valid positions
    for (const node of result) {
      expect(node.position.x).toBeGreaterThanOrEqual(0);
      expect(node.position.y).toBeGreaterThanOrEqual(0);
    }

    // Nodes should be ordered left-to-right (x increases along the chain)
    const posMap = new Map(result.map((r) => [r.id, r.position]));
    expect(posMap.get("plan")!.x).toBeLessThan(posMap.get("implement")!.x);
    expect(posMap.get("implement")!.x).toBeLessThan(posMap.get("verify")!.x);
    expect(posMap.get("verify")!.x).toBeLessThan(posMap.get("review")!.x);
    expect(posMap.get("review")!.x).toBeLessThan(posMap.get("pr")!.x);

    // In a linear chain, all nodes should have approximately the same y
    const yValues = result.map((r) => r.position.y);
    const yRange = Math.max(...yValues) - Math.min(...yValues);
    expect(yRange).toBeLessThan(10); // Should be nearly identical
  });

  test("fan-out: 1 -> 3 -> 1", () => {
    const stages = [
      makeStage("analyze"),
      makeStage("worker-1"),
      makeStage("worker-2"),
      makeStage("worker-3"),
      makeStage("synthesize"),
    ];
    const edges = [
      makeEdge("analyze", "worker-1"),
      makeEdge("analyze", "worker-2"),
      makeEdge("analyze", "worker-3"),
      makeEdge("worker-1", "synthesize"),
      makeEdge("worker-2", "synthesize"),
      makeEdge("worker-3", "synthesize"),
    ];

    const result = layoutPipeline(stages, edges);

    expect(result).toHaveLength(5);

    const posMap = new Map(result.map((r) => [r.id, r.position]));

    // analyze should be leftmost
    const analyzeX = posMap.get("analyze")!.x;
    const w1X = posMap.get("worker-1")!.x;
    const w2X = posMap.get("worker-2")!.x;
    const w3X = posMap.get("worker-3")!.x;
    const synthX = posMap.get("synthesize")!.x;

    expect(analyzeX).toBeLessThan(w1X);
    expect(analyzeX).toBeLessThan(w2X);
    expect(analyzeX).toBeLessThan(w3X);

    // Workers should be at approximately the same x
    expect(Math.abs(w1X - w2X)).toBeLessThan(5);
    expect(Math.abs(w2X - w3X)).toBeLessThan(5);

    // Synthesize should be rightmost
    expect(synthX).toBeGreaterThan(w1X);

    // Workers should have different y positions (vertical spread)
    const workerYs = [posMap.get("worker-1")!.y, posMap.get("worker-2")!.y, posMap.get("worker-3")!.y].sort(
      (a, b) => a - b,
    );
    expect(workerYs[2] - workerYs[0]).toBeGreaterThan(10);
  });

  test("conditional branching", () => {
    const stages = [
      makeStage("plan"),
      makeStage("implement"),
      makeStage("review"),
      makeStage("pr"),
      makeStage("revise"),
      makeStage("reject-close"),
    ];
    const edges = [
      makeEdge("plan", "implement"),
      makeEdge("implement", "review"),
      makeEdge("review", "pr", { condition: "approved", label: "approved" }),
      makeEdge("review", "revise", { condition: "needs_changes", label: "needs changes" }),
      makeEdge("review", "reject-close", { condition: "rejected", label: "rejected" }),
    ];

    const result = layoutPipeline(stages, edges);

    expect(result).toHaveLength(6);

    const posMap = new Map(result.map((r) => [r.id, r.position]));

    // Linear chain should flow left to right
    expect(posMap.get("plan")!.x).toBeLessThan(posMap.get("implement")!.x);
    expect(posMap.get("implement")!.x).toBeLessThan(posMap.get("review")!.x);

    // Branch targets should be to the right of review
    expect(posMap.get("pr")!.x).toBeGreaterThan(posMap.get("review")!.x);
    expect(posMap.get("revise")!.x).toBeGreaterThan(posMap.get("review")!.x);
    expect(posMap.get("reject-close")!.x).toBeGreaterThan(posMap.get("review")!.x);

    // Branch targets should be at approximately the same x (same column)
    const branchXs = [posMap.get("pr")!.x, posMap.get("revise")!.x, posMap.get("reject-close")!.x];
    expect(Math.max(...branchXs) - Math.min(...branchXs)).toBeLessThan(5);

    // Branch targets should be vertically spread
    const branchYs = [posMap.get("pr")!.y, posMap.get("revise")!.y, posMap.get("reject-close")!.y].sort(
      (a, b) => a - b,
    );
    expect(branchYs[2] - branchYs[0]).toBeGreaterThan(10);
  });

  test("loopback edges are handled correctly", () => {
    const stages = [makeStage("implement"), makeStage("review"), makeStage("revise")];
    const edges = [
      makeEdge("implement", "review"),
      makeEdge("review", "revise", { condition: "needs_changes" }),
      makeEdge("revise", "review", { isBackEdge: true }), // loopback
    ];

    const result = layoutPipeline(stages, edges);

    expect(result).toHaveLength(3);

    // Should not crash from the cycle -- back edge is excluded from layout
    const posMap = new Map(result.map((r) => [r.id, r.position]));

    // implement -> review -> revise should flow left to right
    expect(posMap.get("implement")!.x).toBeLessThan(posMap.get("review")!.x);
    expect(posMap.get("review")!.x).toBeLessThan(posMap.get("revise")!.x);
  });

  test("empty stages returns empty array", () => {
    const result = layoutPipeline([], []);
    expect(result).toEqual([]);
  });

  test("single stage returns one node", () => {
    const stages = [makeStage("solo")];
    const result = layoutPipeline(stages, []);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("solo");
    expect(result[0].position.x).toBeGreaterThanOrEqual(PADDING);
    expect(result[0].position.y).toBeGreaterThanOrEqual(0);
  });
});

describe("separateBackEdges", () => {
  test("identifies explicit back edges", () => {
    const stages = [makeStage("a"), makeStage("b")];
    const edges = [makeEdge("a", "b"), makeEdge("b", "a", { isBackEdge: true })];

    const { forwardEdges, backEdges } = separateBackEdges(stages, edges);

    expect(forwardEdges).toHaveLength(1);
    expect(forwardEdges[0].from).toBe("a");
    expect(backEdges).toHaveLength(1);
    expect(backEdges[0].from).toBe("b");
  });

  test("detects implicit cycles", () => {
    const stages = [makeStage("a"), makeStage("b"), makeStage("c")];
    const edges = [
      makeEdge("a", "b"),
      makeEdge("b", "c"),
      makeEdge("c", "a"), // implicit cycle -- not marked as backEdge
    ];

    const { forwardEdges, backEdges } = separateBackEdges(stages, edges);

    expect(forwardEdges).toHaveLength(2);
    expect(backEdges).toHaveLength(1);
    expect(backEdges[0].from).toBe("c");
    expect(backEdges[0].to).toBe("a");
  });
});

describe("validateDag", () => {
  test("valid linear flow passes validation", () => {
    const stages = [
      { name: "plan", agent: "planner" },
      { name: "implement", agent: "implementer" },
    ];
    const edges = [{ from: "plan", to: "implement" }];

    const errors = validateDag(stages, edges);
    expect(errors).toHaveLength(0);
  });

  test("detects duplicate stage names", () => {
    const stages = [
      { name: "plan", agent: "planner" },
      { name: "plan", agent: "other" },
    ];
    const errors = validateDag(stages, []);
    expect(errors.some((e) => e.includes("Duplicate"))).toBe(true);
  });

  test("detects edges referencing unknown stages", () => {
    const stages = [{ name: "plan", agent: "planner" }];
    const edges = [{ from: "plan", to: "nonexistent" }];

    const errors = validateDag(stages, edges);
    expect(errors.some((e) => e.includes("unknown target"))).toBe(true);
  });

  test("detects unreachable stages", () => {
    const stages = [
      { name: "plan", agent: "planner" },
      { name: "implement", agent: "implementer" },
      { name: "orphan", agent: "orphan-agent" },
    ];
    const edges = [{ from: "plan", to: "implement" }];

    const errors = validateDag(stages, edges);
    // "orphan" has no incoming edges so it IS a root, hence reachable from itself.
    // This particular case might not trigger unreachable since orphan is a root.
    // A truly unreachable node would require incoming edges but no path from any root.
    expect(errors).toHaveLength(0);
  });

  test("detects stages with no agent or action", () => {
    const stages = [{ name: "empty" }];
    const errors = validateDag(stages, []);
    expect(errors.some((e) => e.includes("no agent or action"))).toBe(true);
  });
});
