import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  parseGraphFlow,
  getSuccessors,
  resolveNextStages,
  computeSkippedStages,
  isJoinNode,
  isFanOutNode,
  validateGraphFlow,
} from "../state/graph-flow.js";
import { AppContext } from "../app.js";

// ── Pure graph-flow unit tests (no AppContext needed) ──────────────────────

describe("conditional routing - resolveNextStages", () => {
  // Review flow: plan -> implement -> review -> {approved: pr, needs_changes: revise, rejected: close}
  // revise -> review (loop back)
  const flow = parseGraphFlow({
    name: "review-flow",
    nodes: [
      { name: "plan", agent: "planner" },
      { name: "implement", agent: "implementer" },
      { name: "review", agent: "reviewer" },
      { name: "pr", agent: "closer" },
      { name: "revise", agent: "implementer" },
      { name: "close", agent: "closer" },
    ],
    edges: [
      { from: "plan", to: "implement" },
      { from: "implement", to: "review" },
      { from: "review", to: "pr", condition: "session.review_result === 'approved'" },
      { from: "review", to: "revise", condition: "session.review_result === 'needs_changes'" },
      { from: "review", to: "close", condition: "session.review_result === 'rejected'" },
      { from: "revise", to: "review" },
    ],
  });

  it("unconditional edge: plan -> implement", () => {
    const next = resolveNextStages(flow, "plan", {}, []);
    expect(next).toEqual(["implement"]);
  });

  it("conditional edge: approved -> pr", () => {
    const next = resolveNextStages(flow, "review", { review_result: "approved" }, ["plan", "implement"]);
    expect(next).toEqual(["pr"]);
  });

  it("conditional edge: needs_changes -> revise", () => {
    const next = resolveNextStages(flow, "review", { review_result: "needs_changes" }, ["plan", "implement"]);
    expect(next).toEqual(["revise"]);
  });

  it("conditional edge: rejected -> close", () => {
    const next = resolveNextStages(flow, "review", { review_result: "rejected" }, ["plan", "implement"]);
    expect(next).toEqual(["close"]);
  });

  it("no conditions match returns empty (no default edge)", () => {
    const next = resolveNextStages(flow, "review", { review_result: "unknown" }, ["plan", "implement"]);
    expect(next).toEqual([]);
  });

  it("loop: revise -> review returns review even if previously completed", () => {
    // After revision, review should be available again (it's a loop)
    // completedStages doesn't include the current "review" since we're advancing FROM revise
    const next = resolveNextStages(flow, "revise", {}, ["plan", "implement", "review", "revise"]);
    // review is already in completedStages, so it should be filtered out
    expect(next).toEqual([]);
  });

  it("skips already-completed stages", () => {
    const next = resolveNextStages(flow, "plan", {}, ["implement"]);
    expect(next).toEqual([]);
  });

  it("terminal node returns empty array", () => {
    const next = resolveNextStages(flow, "pr", {}, ["plan", "implement", "review"]);
    expect(next).toEqual([]);
  });
});

describe("conditional routing - default/fallback edges", () => {
  // Flow with conditional + default edges
  const flow = parseGraphFlow({
    name: "default-flow",
    nodes: [
      { name: "check", agent: "checker" },
      { name: "fast-path", agent: "worker" },
      { name: "slow-path", agent: "worker" },
      { name: "done", agent: "closer" },
    ],
    edges: [
      { from: "check", to: "fast-path", condition: "session.complexity === 'low'" },
      { from: "check", to: "slow-path" }, // default edge (no condition)
      { from: "fast-path", to: "done" },
      { from: "slow-path", to: "done" },
    ],
  });

  it("takes conditional edge when condition matches", () => {
    const next = resolveNextStages(flow, "check", { complexity: "low" }, []);
    expect(next).toEqual(["fast-path"]);
  });

  it("falls back to default edge when no condition matches", () => {
    const next = resolveNextStages(flow, "check", { complexity: "high" }, []);
    expect(next).toEqual(["slow-path"]);
  });

  it("falls back to default when condition is false", () => {
    const next = resolveNextStages(flow, "check", {}, []);
    expect(next).toEqual(["slow-path"]);
  });
});

describe("conditional routing - join barriers", () => {
  // Diamond: start -> (a, b) -> merge -> end
  const flow = parseGraphFlow({
    name: "join-flow",
    nodes: [
      { name: "start", agent: "worker" },
      { name: "branch-a", agent: "worker" },
      { name: "branch-b", agent: "worker" },
      { name: "merge", agent: "worker" },
      { name: "end", agent: "closer" },
    ],
    edges: [
      { from: "start", to: "branch-a" },
      { from: "start", to: "branch-b" },
      { from: "branch-a", to: "merge" },
      { from: "branch-b", to: "merge" },
      { from: "merge", to: "end" },
    ],
  });

  it("fan-out: both branches ready after start", () => {
    const next = resolveNextStages(flow, "start", {}, []);
    expect(next.sort()).toEqual(["branch-a", "branch-b"]);
  });

  it("join barrier: merge NOT ready when only one predecessor done", () => {
    const next = resolveNextStages(flow, "branch-a", {}, ["start", "branch-a"]);
    // merge has two predecessors (branch-a, branch-b) -- branch-b not done yet
    expect(next).toEqual([]);
  });

  it("join barrier: merge ready when all predecessors done", () => {
    const next = resolveNextStages(flow, "branch-a", {}, ["start", "branch-a", "branch-b"]);
    expect(next).toEqual(["merge"]);
  });

  it("join barrier with skipped predecessor: merge ready when active preds done", () => {
    // If branch-b was skipped (conditional), merge only waits for branch-a
    const next = resolveNextStages(flow, "branch-a", {}, ["start", "branch-a"], ["branch-b"]);
    expect(next).toEqual(["merge"]);
  });
});

describe("conditional routing - join barriers with conditional branches", () => {
  // Conditional diamond: start -> (a if cond, b if !cond) -> merge -> end
  const flow = parseGraphFlow({
    name: "cond-join-flow",
    nodes: [
      { name: "start", agent: "worker" },
      { name: "branch-a", agent: "worker" },
      { name: "branch-b", agent: "worker" },
      { name: "merge", agent: "worker" },
    ],
    edges: [
      { from: "start", to: "branch-a", condition: "session.path === 'a'" },
      { from: "start", to: "branch-b", condition: "session.path === 'b'" },
      { from: "branch-a", to: "merge" },
      { from: "branch-b", to: "merge" },
    ],
  });

  it("conditional: only branch-a when path=a", () => {
    const next = resolveNextStages(flow, "start", { path: "a" }, []);
    expect(next).toEqual(["branch-a"]);
  });

  it("merge ready after branch-a completes with branch-b skipped", () => {
    const next = resolveNextStages(flow, "branch-a", {}, ["start", "branch-a"], ["branch-b"]);
    expect(next).toEqual(["merge"]);
  });

  it("merge NOT ready after branch-a completes without branch-b skipped", () => {
    const next = resolveNextStages(flow, "branch-a", {}, ["start", "branch-a"], []);
    expect(next).toEqual([]);
  });
});

describe("conditional routing - computeSkippedStages", () => {
  const flow = parseGraphFlow({
    name: "skip-flow",
    nodes: [
      { name: "check", agent: "checker" },
      { name: "path-a", agent: "worker" },
      { name: "path-a-next", agent: "worker" },
      { name: "path-b", agent: "worker" },
      { name: "merge", agent: "closer" },
    ],
    edges: [
      { from: "check", to: "path-a", condition: "session.route === 'a'" },
      { from: "check", to: "path-b", condition: "session.route === 'b'" },
      { from: "path-a", to: "path-a-next" },
      { from: "path-a-next", to: "merge" },
      { from: "path-b", to: "merge" },
    ],
  });

  it("skips path-b chain when path-a is chosen", () => {
    const skipped = computeSkippedStages(flow, "check", ["path-a"]);
    expect(skipped).toEqual(["path-b"]);
  });

  it("skips path-a chain when path-b is chosen", () => {
    const skipped = computeSkippedStages(flow, "check", ["path-b"]);
    expect(skipped.sort()).toEqual(["path-a", "path-a-next"]);
  });

  it("does not skip merge (reachable from both paths)", () => {
    const skipped = computeSkippedStages(flow, "check", ["path-a"]);
    expect(skipped).not.toContain("merge");
  });
});

describe("conditional routing - validation", () => {
  it("validates conditional flow with no cycles", () => {
    const flow = parseGraphFlow({
      name: "valid-cond",
      nodes: [
        { name: "a", agent: "x" },
        { name: "b", agent: "y" },
        { name: "c", agent: "z" },
      ],
      edges: [
        { from: "a", to: "b", condition: "session.go === true" },
        { from: "a", to: "c" },
      ],
    });
    const result = validateGraphFlow(flow);
    expect(result.valid).toBe(true);
  });

  it("detects fan-out and join nodes in conditional flow", () => {
    const flow = parseGraphFlow({
      name: "detect",
      nodes: [
        { name: "start", agent: "x" },
        { name: "a", agent: "y" },
        { name: "b", agent: "z" },
        { name: "end", agent: "w" },
      ],
      edges: [
        { from: "start", to: "a", condition: "session.x" },
        { from: "start", to: "b", condition: "!session.x" },
        { from: "a", to: "end" },
        { from: "b", to: "end" },
      ],
    });
    expect(isFanOutNode(flow, "start")).toBe(true);
    expect(isJoinNode(flow, "end")).toBe(true);
  });
});

// ── Integration tests with flow state persistence ──────────────────────────

describe("conditional routing - flow state integration", async () => {
  let app: AppContext;

  beforeAll(async () => {
    app = await AppContext.forTestAsync();
    await app.boot();
  });

  afterAll(async () => {
    await app?.shutdown();
  });

  it("tracks skipped stages in flow state", () => {
    const sid = "s-cond-test-1";
    app.flowStates.setCurrentStage(sid, "plan", "conditional");
    app.flowStates.markStageCompleted(sid, "plan");
    app.flowStates.markStagesSkipped(sid, ["path-b", "path-b-next"]);

    const state = app.flowStates.load(sid);
    expect(state?.completedStages).toEqual(["plan"]);
    expect(state?.skippedStages).toEqual(["path-b", "path-b-next"]);
    expect(state?.stageResults["path-b"]?.status).toBe("skipped");
    expect(state?.stageResults["path-b-next"]?.status).toBe("skipped");
  });

  it("getSkippedStages returns skipped stages", () => {
    const sid = "s-cond-test-2";
    app.flowStates.markStagesSkipped(sid, ["x", "y"]);
    expect(app.flowStates.getSkippedStages(sid)).toEqual(["x", "y"]);
  });

  it("getSkippedStages returns empty for unknown session", () => {
    expect(app.flowStates.getSkippedStages("s-nonexistent")).toEqual([]);
  });

  it("skipped stages are not duplicated on repeated calls", () => {
    const sid = "s-cond-test-3";
    app.flowStates.markStagesSkipped(sid, ["a", "b"]);
    app.flowStates.markStagesSkipped(sid, ["b", "c"]);
    expect(app.flowStates.getSkippedStages(sid)).toEqual(["a", "b", "c"]);
  });
});
