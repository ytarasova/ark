/**
 * Unit tests for `validateFlowPayload` (#403).
 *
 * Pure function; no AppContext needed. Exercises the happy path plus every
 * failure mode the dry-run RPC surfaces: missing flow, empty stages, DAG
 * cycles, unknown depends_on refs, unknown on_outcome targets, missing
 * required inputs (legacy + flat shapes), regex pattern mismatches, and
 * `requires_repo` gating.
 */

import { describe, test, expect } from "bun:test";
import { validateFlowPayload, type FlowDefinition, type StageDefinition } from "../state/flow.js";

function flow(stages: StageDefinition[], extra: Partial<FlowDefinition> = {}): FlowDefinition {
  return { name: "t", stages, ...extra };
}

describe("validateFlowPayload", () => {
  test("returns no problems for a linear valid flow", () => {
    const f = flow([
      { name: "plan", agent: "planner", gate: "auto" },
      { name: "impl", agent: "implementer", gate: "auto" },
    ]);
    expect(validateFlowPayload({ flow: f })).toEqual([]);
  });

  test("reports flow-not-found when flow is null", () => {
    const problems = validateFlowPayload({ flow: null });
    expect(problems).toContain("flow not found");
  });

  test("reports empty-stages when the flow has no stages", () => {
    const problems = validateFlowPayload({ flow: flow([]) });
    expect(problems.some((p) => p.includes("at least one stage"))).toBe(true);
  });

  test("surfaces DAG cycles via validateDAG", () => {
    const f = flow([
      { name: "a", agent: "x", gate: "auto", depends_on: ["b"] },
      { name: "b", agent: "x", gate: "auto", depends_on: ["a"] },
    ]);
    const problems = validateFlowPayload({ flow: f });
    expect(problems.some((p) => /cycle/i.test(p))).toBe(true);
  });

  test("surfaces unknown depends_on refs", () => {
    const f = flow([
      { name: "a", agent: "x", gate: "auto" },
      { name: "b", agent: "x", gate: "auto", depends_on: ["nonexistent"] },
    ]);
    const problems = validateFlowPayload({ flow: f });
    expect(problems.some((p) => p.includes("nonexistent"))).toBe(true);
  });

  test("surfaces unknown on_outcome target refs", () => {
    const f = flow([{ name: "review", agent: "reviewer", gate: "review", on_outcome: { approved: "deploy" } }]);
    const problems = validateFlowPayload({ flow: f });
    expect(problems.some((p) => p.includes("deploy"))).toBe(true);
  });

  test("reports requires_repo when no repo passed", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], { requires_repo: true });
    const problems = validateFlowPayload({ flow: f });
    expect(problems.some((p) => p.includes("requires a repo"))).toBe(true);
  });

  test("accepts requires_repo when repo is passed", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], { requires_repo: true });
    const problems = validateFlowPayload({ flow: f, repo: "/tmp/repo" });
    expect(problems).toEqual([]);
  });

  test("reports missing required input (flat-bag shape)", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { ticket_id: { type: "string", required: true } },
    });
    const problems = validateFlowPayload({ flow: f });
    expect(problems.some((p) => p.includes("ticket_id"))).toBe(true);
  });

  test("applies default and accepts missing required input (flat-bag shape)", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { env: { type: "string", required: true, default: "dev" } },
    });
    expect(validateFlowPayload({ flow: f })).toEqual([]);
  });

  test("reports regex mismatch (flat-bag shape)", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { ticket_id: { type: "string", pattern: "^[A-Z]+-\\d+$" } },
    });
    const problems = validateFlowPayload({ flow: f, inputs: { ticket_id: "lowercase-1" } });
    expect(problems.some((p) => p.includes("does not match pattern"))).toBe(true);
  });

  test("accepts regex match (flat-bag shape)", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { ticket_id: { type: "string", pattern: "^[A-Z]+-\\d+$" } },
    });
    expect(validateFlowPayload({ flow: f, inputs: { ticket_id: "ABC-123" } })).toEqual([]);
  });

  test("reports missing required input (legacy nested shape)", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { files: { plan: { required: true } } },
    });
    const problems = validateFlowPayload({ flow: f });
    expect(problems.some((p) => p.includes("plan"))).toBe(true);
  });

  test("legacy nested: reports regex mismatch", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { params: { version: { required: true, pattern: "^v\\d+$" } } },
    });
    const problems = validateFlowPayload({
      flow: f,
      inputs: { params: { version: "beta" } },
    });
    expect(problems.some((p) => p.includes("does not match pattern"))).toBe(true);
  });

  test("legacy nested: accepts flat-bag inputs for required params", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { params: { version: { required: true } } },
    });
    expect(validateFlowPayload({ flow: f, inputs: { version: "v1" } })).toEqual([]);
  });

  test("reports invalid pattern regex in the declaration itself", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { k: { type: "string", pattern: "[" } }, // unterminated bracket
    });
    const problems = validateFlowPayload({ flow: f, inputs: { k: "anything" } });
    expect(problems.some((p) => p.includes("not a valid regex"))).toBe(true);
  });

  test("bare default declaration is tolerated (no constraints to check)", () => {
    const f = flow([{ name: "s", agent: "a", gate: "auto" }], {
      inputs: { mode: "balanced" as unknown as never },
    });
    expect(validateFlowPayload({ flow: f })).toEqual([]);
  });
});
