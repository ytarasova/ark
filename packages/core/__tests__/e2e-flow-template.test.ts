/**
 * E2E tests for flow templating -- verifies the full pipeline:
 * flow YAML with task templates -> resolveFlow with session vars -> substituted output.
 * Also verifies resolveAgent still works with the shared template helper.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { resolveFlow } from "../state/flow.js";
import { resolveAgent } from "../agent/agent.js";
import { substituteVars, buildSessionVars } from "../template.js";

let app: AppContext;

const flowDir = () => join(getApp().config.arkDir, "flows");
const agentDir = () => join(getApp().config.arkDir, "agents");

function writeFlowYaml(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

function writeAgentYaml(name: string, data: Record<string, unknown>): void {
  const dir = agentDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data));
}

beforeEach(async () => {
  if (app) { await app.shutdown(); clearApp(); }
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
  rmSync(flowDir(), { recursive: true, force: true });
  rmSync(agentDir(), { recursive: true, force: true });
});

afterAll(async () => {
  if (app) { await app.shutdown(); clearApp(); }
});

// ── Flow templating E2E ─────────────────────────────────────────────────────

describe("Flow templating E2E", () => {
  it("resolveFlow substitutes task field with session variables", () => {
    writeFlowYaml("templated", {
      name: "templated",
      stages: [
        { name: "implement", agent: "implementer", gate: "auto", task: "Implement {ticket}: {summary} in {repo}" },
        { name: "review", agent: "reviewer", gate: "auto", task: "Review {ticket} changes" },
      ],
    });

    const vars = buildSessionVars({
      id: "s-123", ticket: "PROJ-456", summary: "Add auth", repo: "/home/dev/app",
      stage: "implement", flow: "templated",
    });

    const resolved = resolveFlow(getApp(),"templated", vars);
    expect(resolved).not.toBeNull();
    expect(resolved!.stages[0].task).toBe("Implement PROJ-456: Add auth in /home/dev/app");
    expect(resolved!.stages[1].task).toBe("Review PROJ-456 changes");
  });

  it("resolveAgent still works with shared template helper", () => {
    writeAgentYaml("test-agent", {
      name: "test-agent",
      system_prompt: "Working on {ticket} in {repo}",
    });

    const agent = resolveAgent(getApp(), "test-agent", {
      ticket: "BUG-789", repo: "/code/project",
    });
    expect(agent).not.toBeNull();
    expect(agent!.system_prompt).toBe("Working on BUG-789 in /code/project");
  });

  it("stages without task field are unaffected", () => {
    writeFlowYaml("no-task", {
      name: "no-task",
      stages: [
        { name: "work", agent: "worker", gate: "auto" },
      ],
    });

    const vars = buildSessionVars({ id: "s-1", ticket: "X" });
    const resolved = resolveFlow(getApp(),"no-task", vars);
    expect(resolved!.stages[0].task).toBeUndefined();
  });

  it("on_failure gets substituted too", () => {
    writeFlowYaml("failure-tmpl", {
      name: "failure-tmpl",
      stages: [
        { name: "deploy", agent: "deployer", gate: "auto", on_failure: "notify({ticket})" },
      ],
    });

    const vars = buildSessionVars({ id: "s-1", ticket: "DEPLOY-1" });
    const resolved = resolveFlow(getApp(),"failure-tmpl", vars);
    expect(resolved!.stages[0].on_failure).toBe("notify(DEPLOY-1)");
  });

  it("description field gets substituted", () => {
    writeFlowYaml("desc-tmpl", {
      name: "desc-tmpl",
      description: "Pipeline for {ticket} on {branch}",
      stages: [
        { name: "s1", agent: "a", gate: "auto" },
      ],
    });

    const vars = buildSessionVars({ id: "s-1", ticket: "FEAT-10", branch: "main" });
    const resolved = resolveFlow(getApp(),"desc-tmpl", vars);
    expect(resolved!.description).toBe("Pipeline for FEAT-10 on main");
  });

  it("unknown variables are preserved as-is", () => {
    writeFlowYaml("unknown-vars", {
      name: "unknown-vars",
      stages: [
        { name: "s1", agent: "a", gate: "auto", task: "Do {ticket} with {custom_var}" },
      ],
    });

    const vars = buildSessionVars({ id: "s-1", ticket: "T-1" });
    const resolved = resolveFlow(getApp(),"unknown-vars", vars);
    expect(resolved!.stages[0].task).toBe("Do T-1 with {custom_var}");
  });

  it("buildSessionVars + substituteVars round-trip with all fields", () => {
    const vars = buildSessionVars({
      id: "s-full",
      ticket: "PROJ-99",
      summary: "Full test",
      repo: "/repo",
      branch: "dev",
      workdir: "/work",
      stage: "build",
      flow: "ci",
      agent: "builder",
      compute_name: "cloud-1",
    });

    const result = substituteVars(
      "{ticket} {summary} {repo} {branch} {workdir} {track_id} {stage} {flow} {agent} {compute}",
      vars,
    );
    expect(result).toBe("PROJ-99 Full test /repo dev /work s-full build ci builder cloud-1");
  });
});
