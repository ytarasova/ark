/**
 * Integration smoke: load a real agent YAML with {{...}} placeholders and
 * render against a session. Verifies the Nunjucks-backed template engine
 * co-operates with the AgentStore -> resolveAgent path.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { AppContext } from "../app.js";
import { resolveAgent } from "../agent/agent.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

function writeAgent(name: string, data: Record<string, unknown>): void {
  const dir = join(getApp().config.dirs.ark, "agents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data));
}

describe("agent template integration", () => {
  it("renders {{var}} in system_prompt from a real YAML file", () => {
    writeAgent("nunjucks-test", {
      name: "nunjucks-test",
      system_prompt: "You are working on {{ticket}} ({{summary}}) in {{repo}} on branch {{branch}}.",
    });
    const agent = resolveAgent(getApp(), "nunjucks-test", {
      ticket: "NJ-1",
      summary: "migrate template engine",
      repo: "/code/ark",
      branch: "feat/nunjucks",
    });
    expect(agent).not.toBeNull();
    expect(agent!.system_prompt).toBe(
      "You are working on NJ-1 (migrate template engine) in /code/ark on branch feat/nunjucks.",
    );
  });

  it("preserves unknown {{var}} verbatim in the rendered agent prompt", () => {
    writeAgent("nunjucks-unknown", {
      name: "nunjucks-unknown",
      system_prompt: "Task: {{summary}} (owner {{owner}})",
    });
    const agent = resolveAgent(getApp(), "nunjucks-unknown", { summary: "fix X" });
    expect(agent!.system_prompt).toBe("Task: fix X (owner {{owner}})");
  });

  it("resolves {{inputs.files.X}} from session.config.inputs", () => {
    writeAgent("nunjucks-recipe", {
      name: "nunjucks-recipe",
      system_prompt: "Recipe at {{inputs.files.recipe}}",
    });
    const agent = resolveAgent(getApp(), "nunjucks-recipe", {
      id: "s-1",
      config: { inputs: { files: { recipe: "/tmp/recipe.yaml" } } },
    });
    expect(agent!.system_prompt).toBe("Recipe at /tmp/recipe.yaml");
  });

  it("supports conditionals and filters in agent prompts", () => {
    writeAgent("nunjucks-cond", {
      name: "nunjucks-cond",
      system_prompt:
        '{% if ticket %}Working on {{ ticket }}{% else %}No ticket{% endif %} -- env {{ inputs.params.target_env | default("prod") }}.',
    });
    const withTicket = resolveAgent(getApp(), "nunjucks-cond", {
      ticket: "ABC-1",
      config: { inputs: { params: { target_env: "staging" } } },
    });
    expect(withTicket!.system_prompt).toBe("Working on ABC-1 -- env staging.");
    // target_env unset -> default filter kicks in (inputs.params has no target_env).
    const withoutTicket = resolveAgent(getApp(), "nunjucks-cond", { ticket: "" });
    expect(withoutTicket!.system_prompt).toBe("No ticket -- env prod.");
  });
});
