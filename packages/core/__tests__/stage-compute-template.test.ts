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

import { providerOf } from "../../compute/adapters/provider-map.js";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { AppContext } from "../app.js";
import { getStage, getStages } from "../state/flow.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
});

/** Directory where flow.ts looks for user flows. */
const flowDir = () => join(app.config.dirs.ark, "flows");

/** Write a YAML flow definition to the user flows directory. */
function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(async () => {
  // Clean user flows dir so each test starts fresh
  rmSync(flowDir(), { recursive: true, force: true });
  // Clean templates
  for (const t of await app.computeTemplates.list()) {
    await app.computeTemplates.delete(t.name);
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
      stages: [{ name: "work", agent: "worker", gate: "auto" }],
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

describe("resolveComputeForStage", async () => {
  it("returns null when stageDef is null", async () => {
    const result = await app.dispatchService.resolveComputeForStage(null, "s-test");
    expect(result).toBeNull();
  });

  it("returns null when stage has no compute_template", async () => {
    const stageDef = { name: "work", gate: "auto" as const };
    const result = await app.dispatchService.resolveComputeForStage(stageDef, "s-test");
    expect(result).toBeNull();
  });

  it("returns null when template is not found in DB or config", async () => {
    const logs: string[] = [];
    const stageDef = { name: "work", gate: "auto" as const, compute_template: "nonexistent" };
    const result = await app.dispatchService.resolveComputeForStage(stageDef, "s-test", (m) => logs.push(m));
    expect(result).toBeNull();
    expect(logs.some((l) => l.includes("not found"))).toBe(true);
  });

  it("provisions compute from DB template when no existing compute", async () => {
    // Create a template in DB
    await app.computeTemplates.create({
      name: "fast-docker",
      provider: "docker",
      config: { image: "node:20" },
    });

    const session = await app.sessions.create({ summary: "template-test" });
    const stageDef = { name: "implement", gate: "auto" as const, compute_template: "fast-docker" };
    const logs: string[] = [];

    const result = await app.dispatchService.resolveComputeForStage(stageDef, session.id, (m) => logs.push(m));
    // Upstream adc10203 clones templates with a session-suffixed name so the
    // GC can tear them down per-session. The resolved name is the clone, not
    // the source template.
    expect(result).toMatch(/^fast-docker-/);

    // Verify the clone was created with the template's provider
    const clone = await app.computes.get(result!);
    expect(clone).not.toBeNull();
    expect(providerOf(clone!)).toBe("docker");

    // Verify event was logged
    const events = await app.events.list(session.id);
    const provisionEvent = events.find((e) => e.type === "compute_cloned_from_template");
    expect(provisionEvent).toBeDefined();
    expect(provisionEvent!.data?.template).toBe("fast-docker");

    // Clean up the clone
    await app.computes.delete(result!);
  });

  it("resolves template from config when not in DB", async () => {
    // Temporarily add to config
    const originalTemplates = app.config.computeTemplates;
    app.config.computeTemplates = [{ name: "config-tmpl", provider: "docker", config: { image: "alpine" } }];

    const session = await app.sessions.create({ summary: "config-test" });
    const stageDef = { name: "build", gate: "auto" as const, compute_template: "config-tmpl" };

    const result = await app.dispatchService.resolveComputeForStage(stageDef, session.id);
    // Same session-suffixed clone semantics as above (upstream adc10203).
    expect(result).toMatch(/^config-tmpl-/);

    // Verify compute was created from config template
    const compute = await app.computes.get(result!);
    expect(compute).not.toBeNull();
    expect(providerOf(compute!)).toBe("docker");

    // Restore config
    app.config.computeTemplates = originalTemplates;
    await app.computes.delete(result!);
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
          task: "Implement {{summary}}",
        },
      ],
    });

    const stage = getStage(app, "full-stage-flow", "impl");
    expect(stage).not.toBeNull();
    expect(stage!.compute_template).toBe("sandbox");
    expect(stage!.model).toBe("opus");
    expect(stage!.verify).toEqual(["npm test"]);
    expect(stage!.on_failure).toBe("retry(2)");
    expect(stage!.task).toBe("Implement {{summary}}");
  });
});
