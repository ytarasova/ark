/**
 * Tests for flow.ts — flow loading, stage navigation, gate evaluation,
 * and stage action resolution.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  getStages,
  getStage,
  getFirstStage,
  getNextStage,
  evaluateGate,
  getStageAction,
  resolveFlow,
} from "../flow.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

/** Directory where flow.ts looks for user flows (module-level constant). */
const flowDir = () => join(getApp().config.arkDir, "flows");

/** Write a YAML flow definition to the user flows directory. */
function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(() => {
  // Clean user flows dir so each test starts fresh
  rmSync(flowDir(), { recursive: true, force: true });
});

// ── loadFlow ─────────────────────────────────────────────────────────────────

describe("loadFlow", () => {
  it("returns null for a non-existent flow", () => {
    expect(getApp().flows.get("does-not-exist")).toBeNull();
  });

  it("loads a user-defined flow from the user dir", () => {
    writeUserFlow("my-flow", {
      name: "my-flow",
      description: "test flow",
      stages: [{ name: "alpha", agent: "planner", gate: "auto" }],
    });
    const flow = getApp().flows.get("my-flow");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("my-flow");
    expect(flow!.stages).toHaveLength(1);
    expect(flow!.stages[0].name).toBe("alpha");
  });

  it("loads the builtin 'default' flow", () => {
    const flow = getApp().flows.get("default");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("default");
    expect(flow!.stages.length).toBeGreaterThanOrEqual(1);
  });

  it("user flow overrides a builtin flow of the same name", () => {
    writeUserFlow("default", {
      name: "default",
      description: "user override",
      stages: [{ name: "only-stage", agent: "custom", gate: "manual" }],
    });
    const flow = getApp().flows.get("default");
    expect(flow).not.toBeNull();
    expect(flow!.description).toBe("user override");
    expect(flow!.stages).toHaveLength(1);
    expect(flow!.stages[0].name).toBe("only-stage");
  });
});

// ── listFlows ────────────────────────────────────────────────────────────────

describe("listFlows", () => {
  it("includes builtin flows", () => {
    const flows = getApp().flows.list();
    const names = flows.map((f) => f.name);
    expect(names).toContain("default");
  });

  it("includes user-defined flows", () => {
    writeUserFlow("custom-flow", {
      name: "custom-flow",
      description: "a custom flow",
      stages: [{ name: "s1", agent: "tester", gate: "auto" }],
    });
    const flows = getApp().flows.list();
    const custom = flows.find((f) => f.name === "custom-flow");
    expect(custom).toBeDefined();
    expect(custom!.source).toBe("user");
    expect(custom!.description).toBe("a custom flow");
  });

  it("user flow overrides builtin with same name", () => {
    writeUserFlow("default", {
      name: "default",
      description: "overridden",
      stages: [{ name: "x", agent: "a", gate: "auto" }],
    });
    const flows = getApp().flows.list();
    const defaults = flows.filter((f) => f.name === "default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0].source).toBe("user");
    expect(defaults[0].description).toBe("overridden");
  });

  it("returns stages as an array of stage names", () => {
    const flows = getApp().flows.list();
    const def = flows.find((f) => f.name === "default");
    expect(def).toBeDefined();
    expect(Array.isArray(def!.stages)).toBe(true);
    expect(def!.stages[0]).toBe("intake");
  });
});

// ── getStages ────────────────────────────────────────────────────────────────

describe("getStages", () => {
  it("returns empty array for unknown flow", () => {
    expect(getStages("nonexistent")).toEqual([]);
  });

  it("returns all stages for a known flow", () => {
    const stages = getStages("default");
    const names = stages.map((s) => s.name);
    expect(names).toEqual([
      "intake", "plan", "audit", "implement", "verify", "pr", "review", "close", "retro",
    ]);
  });
});

// ── getStage ─────────────────────────────────────────────────────────────────

describe("getStage", () => {
  it("returns null for unknown flow", () => {
    expect(getStage("nonexistent", "plan")).toBeNull();
  });

  it("returns null for unknown stage name", () => {
    expect(getStage("default", "nonexistent-stage")).toBeNull();
  });

  it("returns the named stage with correct properties", () => {
    const stage = getStage("default", "implement");
    expect(stage).not.toBeNull();
    expect(stage!.name).toBe("implement");
    expect(stage!.agent).toBe("implementer");
    expect(stage!.gate).toBe("auto");
  });
});

// ── getFirstStage ────────────────────────────────────────────────────────────

describe("getFirstStage", () => {
  it("returns null for unknown flow", () => {
    expect(getFirstStage("nonexistent")).toBeNull();
  });

  it("returns the first stage name", () => {
    expect(getFirstStage("default")).toBe("intake");
  });

  it("returns first stage of a user flow", () => {
    writeUserFlow("my-flow", {
      name: "my-flow",
      stages: [
        { name: "alpha", agent: "a", gate: "auto" },
        { name: "beta", agent: "b", gate: "manual" },
      ],
    });
    expect(getFirstStage("my-flow")).toBe("alpha");
  });
});

// ── getNextStage ─────────────────────────────────────────────────────────────

describe("getNextStage", () => {
  it("returns the next stage name", () => {
    expect(getNextStage("default", "intake")).toBe("plan");
    expect(getNextStage("default", "plan")).toBe("audit");
  });

  it("returns null at the last stage", () => {
    expect(getNextStage("default", "retro")).toBeNull();
  });

  it("returns null for unknown current stage", () => {
    expect(getNextStage("default", "nonexistent")).toBeNull();
  });

  it("returns null for unknown flow", () => {
    expect(getNextStage("nonexistent", "plan")).toBeNull();
  });
});

// ── evaluateGate ─────────────────────────────────────────────────────────────

describe("evaluateGate", () => {
  it("auto gate passes without error", () => {
    const result = evaluateGate("default", "implement", {});
    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("auto");
  });

  it("auto gate passes with explicit null error", () => {
    const result = evaluateGate("default", "implement", { error: null });
    expect(result.canProceed).toBe(true);
  });

  it("auto gate fails when session has error", () => {
    const result = evaluateGate("default", "implement", { error: "build failed" });
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("build failed");
  });

  it("manual gate always blocks", () => {
    const result = evaluateGate("default", "plan", {});
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("manual");
  });

  it("condition gate always passes", () => {
    writeUserFlow("cond-flow", {
      name: "cond-flow",
      stages: [{ name: "check", agent: "validator", gate: "condition" }],
    });
    const result = evaluateGate("cond-flow", "check", {});
    expect(result.canProceed).toBe(true);
    expect(result.reason).toContain("condition");
  });

  it("review gate always blocks", () => {
    writeUserFlow("review-flow", {
      name: "review-flow",
      stages: [{ name: "await-pr", agent: "reviewer", gate: "review" }],
    });
    const result = evaluateGate("review-flow", "await-pr", {});
    expect(result.canProceed).toBe(false);
  });

  it("review gate reason contains 'awaiting PR approval'", () => {
    writeUserFlow("review-flow2", {
      name: "review-flow2",
      stages: [{ name: "await-pr", agent: "reviewer", gate: "review" }],
    });
    const result = evaluateGate("review-flow2", "await-pr", {});
    expect(result.reason).toContain("awaiting PR approval");
  });

  it("returns canProceed false for unknown stage", () => {
    const result = evaluateGate("default", "nonexistent", {});
    expect(result.canProceed).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("returns canProceed false for unknown flow", () => {
    const result = evaluateGate("nonexistent", "plan", {});
    expect(result.canProceed).toBe(false);
  });
});

// ── getStageAction ───────────────────────────────────────────────────────────

describe("getStageAction", () => {
  it("returns type 'unknown' for missing flow", () => {
    const action = getStageAction("nonexistent", "plan");
    expect(action.type).toBe("unknown");
  });

  it("returns type 'unknown' for missing stage", () => {
    const action = getStageAction("default", "nonexistent");
    expect(action.type).toBe("unknown");
  });

  it("returns agent type with agent name", () => {
    const action = getStageAction("default", "plan");
    expect(action.type).toBe("agent");
    expect(action.agent).toBe("spec-planner");
  });

  it("returns action type with action name", () => {
    const action = getStageAction("default", "pr");
    expect(action.type).toBe("action");
    expect(action.action).toBe("create_pr");
  });

  it("returns fork type with defaults", () => {
    writeUserFlow("fork-flow", {
      name: "fork-flow",
      stages: [{ name: "split", type: "fork", gate: "auto" }],
    });
    const action = getStageAction("fork-flow", "split");
    expect(action.type).toBe("fork");
    expect(action.agent).toBe("implementer");
    expect(action.strategy).toBe("plan");
    expect(action.max_parallel).toBe(4);
  });

  it("returns fork type with custom values", () => {
    writeUserFlow("fork-custom", {
      name: "fork-custom",
      stages: [{
        name: "split",
        type: "fork",
        gate: "auto",
        agent: "builder",
        strategy: "file",
        max_parallel: 8,
      }],
    });
    const action = getStageAction("fork-custom", "split");
    expect(action.type).toBe("fork");
    expect(action.agent).toBe("builder");
    expect(action.strategy).toBe("file");
    expect(action.max_parallel).toBe(8);
  });

  it("includes optional field when present", () => {
    const action = getStageAction("default", "audit");
    expect(action.optional).toBe(true);
  });

  it("on_failure and optional are undefined when not set", () => {
    const action = getStageAction("default", "pr");
    expect(action.on_failure).toBeUndefined();
    expect(action.optional).toBeUndefined();
  });
});

// ── resolveFlow ─────────────────────────────────────────────────────────────

describe("resolveFlow", () => {
  it("substitutes variables in stage task field", () => {
    writeUserFlow("task-flow", {
      name: "task-flow",
      stages: [
        { name: "plan", agent: "planner", gate: "auto", task: "Plan work for {ticket}: {summary}" },
        { name: "impl", agent: "worker", gate: "auto", task: "Implement {ticket} in {repo}" },
      ],
    });

    const flow = resolveFlow("task-flow", { ticket: "PROJ-1", summary: "Fix bug", repo: "/code" });
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].task).toBe("Plan work for PROJ-1: Fix bug");
    expect(flow!.stages[1].task).toBe("Implement PROJ-1 in /code");
  });

  it("substitutes variables in description", () => {
    writeUserFlow("desc-flow", {
      name: "desc-flow",
      description: "Flow for {ticket} on {branch}",
      stages: [{ name: "s1", agent: "a", gate: "auto" }],
    });

    const flow = resolveFlow("desc-flow", { ticket: "T-1", branch: "main" });
    expect(flow!.description).toBe("Flow for T-1 on main");
  });

  it("substitutes variables in on_failure", () => {
    writeUserFlow("fail-flow", {
      name: "fail-flow",
      stages: [
        { name: "s1", agent: "a", gate: "auto", on_failure: "notify({ticket})" },
      ],
    });

    const flow = resolveFlow("fail-flow", { ticket: "BUG-99" });
    expect(flow!.stages[0].on_failure).toBe("notify(BUG-99)");
  });

  it("preserves stages without templates", () => {
    writeUserFlow("plain-flow", {
      name: "plain-flow",
      stages: [
        { name: "s1", agent: "planner", gate: "auto" },
        { name: "s2", agent: "worker", gate: "manual" },
      ],
    });

    const flow = resolveFlow("plain-flow", { ticket: "X-1" });
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].task).toBeUndefined();
    expect(flow!.stages[0].on_failure).toBeUndefined();
    expect(flow!.stages[0].name).toBe("s1");
    expect(flow!.stages[1].name).toBe("s2");
  });

  it("returns null for unknown flow", () => {
    expect(resolveFlow("nonexistent", { ticket: "X-1" })).toBeNull();
  });

  it("stage task field appears in loaded flow definition", () => {
    writeUserFlow("task-field-flow", {
      name: "task-field-flow",
      stages: [
        { name: "do-it", agent: "worker", gate: "auto", task: "Do the thing" },
      ],
    });

    const flow = getApp().flows.get("task-field-flow");
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].task).toBe("Do the thing");
  });
});
