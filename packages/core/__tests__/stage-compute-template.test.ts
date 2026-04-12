/**
 * Tests for per-stage compute templates in flow definitions.
 *
 * Verifies that:
 * - StageDefinition accepts a compute_template field
 * - resolveComputeForStage resolves templates from DB and config
 * - Compute is auto-provisioned when template exists but compute doesn't
 * - Existing compute is reused when it matches the template name
 * - Null is returned when no template is specified or template not found
 * - Flow YAML with compute_template loads correctly
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { AppContext, setApp, clearApp, getApp } from "../app.js";
import { getStage, getStages } from "../state/flow.js";
import { resolveComputeForStage } from "../services/session-orchestration.js";

let app: AppContext;

beforeAll(async () => {
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

/** Directory where flow.ts looks for user flows. */
const flowDir = () => join(app.config.arkDir, "flows");

/** Write a YAML flow definition to the user flows directory. */
function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(() => {
  // Clean user flows dir so each test starts fresh
  rmSync(flowDir(), { recursive: true, force: true });
  // Clean templates
  for (const t of app.computeTemplates.list()) {
    app.computeTemplates.delete(t.name);
  }
});

// ── StageDefinition.compute_template field ──────────────────────────────────

describe("StageDefinition compute_template field", () => {
  it("loads compute_template from flow YAML", () => {
    writeUserFlow("tmpl-flow", {
      name: "tmpl-flow",
      stages: [
        { name: "plan", agent: "planner", gate: "auto", compute_template: "fast-docker" },
        { name: "implement", agent: "implementer", gate: "auto", compute_template: "heavy-ec2" },
      ],
    });

    const stages = getStages(app, "tmpl-flow");
    expect(stages).toHaveLength(2);
    expect(stages[0].compute_template).toBe("fast-docker");
    expect(stages[1].compute_template).toBe("heavy-ec2");
  });

  it("compute_template is undefined when not specified", () => {
    writeUserFlow("no-tmpl-flow", {
      name: "no-tmpl-flow",
      stages: [
        { name: "work", agent: "worker", gate: "auto" },
      ],
    });

    const stage = getStage(app, "no-tmpl-flow", "work");
    expect(stage).not.toBeNull();
    expect(stage!.compute_template).toBeUndefined();
  });

  it("only some stages can have compute_template", () => {
    writeUserFlow("mixed-flow", {
      name: "mixed-flow",
      stages: [
        { name: "plan", agent: "planner", gate: "auto" },
        { name: "implement", agent: "implementer", gate: "auto", compute_template: "gpu-large" },
        { name: "review", agent: "reviewer", gate: "manual" },
      ],
    });

    const stages = getStages(app, "mixed-flow");
    expect(stages[0].compute_template).toBeUndefined();
    expect(stages[1].compute_template).toBe("gpu-large");
    expect(stages[2].compute_template).toBeUndefined();
  });
});

// ── resolveComputeForStage ─────────────────────────────────────────────────

describe("resolveComputeForStage", () => {
  it("returns null when stageDef is null", () => {
    const result = resolveComputeForStage(app, null, "s-test");
    expect(result).toBeNull();
  });

  it("returns null when stage has no compute_template", () => {
    const stageDef = { name: "work", gate: "auto" as const };
    const result = resolveComputeForStage(app, stageDef, "s-test");
    expect(result).toBeNull();
  });

  it("returns null when template is not found in DB or config", () => {
    const logs: string[] = [];
    const stageDef = { name: "work", gate: "auto" as const, compute_template: "nonexistent" };
    const result = resolveComputeForStage(app, stageDef, "s-test", (m) => logs.push(m));
    expect(result).toBeNull();
    expect(logs.some(l => l.includes("not found"))).toBe(true);
  });

  it("provisions compute from DB template when no existing compute", () => {
    // Create a template in DB
    app.computeTemplates.create({
      name: "fast-docker",
      provider: "docker",
      config: { image: "node:20" },
    });

    const session = app.sessions.create({ summary: "template-test" });
    const stageDef = { name: "implement", gate: "auto" as const, compute_template: "fast-docker" };
    const logs: string[] = [];

    const result = resolveComputeForStage(app, stageDef, session.id, (m) => logs.push(m));
    expect(result).toBe("fast-docker");

    // Verify compute was created
    const compute = app.computes.get("fast-docker");
    expect(compute).not.toBeNull();
    expect(compute!.provider).toBe("docker");

    // Verify event was logged
    const events = app.events.list(session.id);
    const provisionEvent = events.find(e => e.type === "compute_provisioned_from_template");
    expect(provisionEvent).toBeDefined();
    expect(provisionEvent!.data?.template).toBe("fast-docker");

    // Clean up
    app.computes.delete("fast-docker");
  });

  it("reuses existing compute when it matches template name", () => {
    // Create template and a matching compute
    app.computeTemplates.create({
      name: "existing-compute",
      provider: "ec2",
      config: { size: "xl" },
    });
    app.computes.create({ name: "existing-compute", provider: "ec2", config: { size: "xl" } });

    const session = app.sessions.create({ summary: "reuse-test" });
    const stageDef = { name: "work", gate: "auto" as const, compute_template: "existing-compute" };
    const logs: string[] = [];

    const result = resolveComputeForStage(app, stageDef, session.id, (m) => logs.push(m));
    expect(result).toBe("existing-compute");
    expect(logs.some(l => l.includes("existing compute"))).toBe(true);

    // Verify no new provision event (reused existing)
    const events = app.events.list(session.id);
    const provisionEvent = events.find(e => e.type === "compute_provisioned_from_template");
    expect(provisionEvent).toBeUndefined();

    app.computes.delete("existing-compute");
  });

  it("resolves template from config when not in DB", () => {
    // Temporarily add to config
    const originalTemplates = app.config.computeTemplates;
    app.config.computeTemplates = [
      { name: "config-tmpl", provider: "docker", config: { image: "alpine" } },
    ];

    const session = app.sessions.create({ summary: "config-test" });
    const stageDef = { name: "build", gate: "auto" as const, compute_template: "config-tmpl" };

    const result = resolveComputeForStage(app, stageDef, session.id);
    expect(result).toBe("config-tmpl");

    // Verify compute was created from config template
    const compute = app.computes.get("config-tmpl");
    expect(compute).not.toBeNull();
    expect(compute!.provider).toBe("docker");

    // Restore config
    app.config.computeTemplates = originalTemplates;
    app.computes.delete("config-tmpl");
  });
});

// ── Integration: flow YAML with compute_template ────────────────────────────

describe("flow with per-stage compute templates", () => {
  it("different stages can specify different compute templates", () => {
    writeUserFlow("multi-compute-flow", {
      name: "multi-compute-flow",
      description: "Flow with per-stage compute",
      stages: [
        {
          name: "plan",
          agent: "planner",
          gate: "auto",
          compute_template: "lightweight",
        },
        {
          name: "implement",
          agent: "implementer",
          gate: "auto",
          compute_template: "heavy-gpu",
          on_failure: "retry(3)",
        },
        {
          name: "review",
          agent: "reviewer",
          gate: "manual",
        },
      ],
    });

    const flow = app.flows.get("multi-compute-flow");
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].compute_template).toBe("lightweight");
    expect(flow!.stages[1].compute_template).toBe("heavy-gpu");
    expect(flow!.stages[2].compute_template).toBeUndefined();
  });

  it("compute_template coexists with other stage fields", () => {
    writeUserFlow("full-stage-flow", {
      name: "full-stage-flow",
      stages: [
        {
          name: "impl",
          agent: "implementer",
          gate: "auto",
          model: "opus",
          compute_template: "sandbox",
          verify: ["npm test"],
          on_failure: "retry(2)",
          task: "Implement {summary}",
        },
      ],
    });

    const stage = getStage(app, "full-stage-flow", "impl");
    expect(stage).not.toBeNull();
    expect(stage!.compute_template).toBe("sandbox");
    expect(stage!.model).toBe("opus");
    expect(stage!.verify).toEqual(["npm test"]);
    expect(stage!.on_failure).toBe("retry(2)");
    expect(stage!.task).toBe("Implement {summary}");
  });
});
