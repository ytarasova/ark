/**
 * Tests for `resolveStage` -- the stage resolution pipeline that walks
 * (stage.agent -> runtime -> model) where each level is either a string name
 * or an inline object. Exercises the five expected paths plus the error
 * messages surfaced for every missing ref.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import YAML from "yaml";

import { AppContext } from "../app.js";
import { FileModelStore } from "../stores/model-store.js";
import { resolveStage } from "../resolution/resolve-stage.js";
import type { StageDefinition } from "../state/flow.js";
import type { Session } from "../../types/index.js";

// Shared helpers
function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ark-resolve-stage-"));
}

function writeYaml(dir: string, file: string, data: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), YAML.stringify(data));
}

// Stand-in session -- resolveStage only reads .workdir / .repo to pick the
// project root. Everything else is templated in system prompts.
const fakeSession = {
  id: "test",
  workdir: null,
  repo: null,
  summary: "hello",
  ticket: null,
  branch: null,
  flow: "test",
} as unknown as Session;

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();

  // Swap in a bespoke model store that has exactly the fixtures we need --
  // forTestAsync points at a blank arkDir so we need a seeded bundled layer.
  const bundled = tmp();
  writeYaml(bundled, "claude-sonnet.yaml", {
    id: "claude-sonnet-4-6",
    display: "Claude Sonnet 4.6",
    provider: "anthropic",
    aliases: ["sonnet"],
    provider_slugs: {
      "anthropic-direct": "claude-sonnet-4-6",
      "tf-bedrock": "pi-agentic/global.anthropic.claude-sonnet-4-6",
    },
  });
  writeYaml(bundled, "claude-opus.yaml", {
    id: "claude-opus-4-7",
    display: "Claude Opus 4.7",
    provider: "anthropic",
    aliases: ["opus"],
    provider_slugs: { "anthropic-direct": "claude-opus-4-7" },
  });

  // Override the DI-registered store for the duration of this file. We use
  // `asValue` so the re-registration is a first-class singleton in the
  // cradle -- otherwise downstream SINGLETON stores (hosted agent store)
  // that depend on `models` fail awilix's strict lifetime check.
  const modelStore = new FileModelStore({ builtinDir: bundled, userDir: tmp() });
  const { asValue: asValueHelper } = await import("awilix");
  (app as unknown as { _container: { register: (obj: Record<string, unknown>) => void } })._container.register({
    models: asValueHelper(modelStore),
  });
  // Simpler approach: monkey-patch the accessor via Object.defineProperty.
  Object.defineProperty(app, "models", { configurable: true, get: () => modelStore });

  // Seed a runtime for the named-runtime path. Writing to app.runtimes requires
  // a savable store -- use the default FileRuntimeStore the test profile gives
  // us by writing YAML into arkDir/runtimes.
  const rtDir = join(app.arkDir, "runtimes");
  writeYaml(rtDir, "claude-agent.yaml", {
    name: "claude-agent",
    description: "test claude-agent runtime",
    type: "claude-agent",
    permission_mode: "bypassPermissions",
  });

  // Seed an agent for the all-named path.
  const agentsDir = join(app.arkDir, "agents");
  writeYaml(agentsDir, "worker.yaml", {
    name: "worker",
    description: "test worker",
    runtime: "claude-agent",
    model: "sonnet",
    max_turns: 200,
    system_prompt: "Be helpful.",
    tools: ["Read"],
    mcp_servers: [],
    skills: [],
    memories: [],
    context: [],
    permission_mode: "bypassPermissions",
    env: {},
  });
});

afterAll(async () => {
  await app?.shutdown();
});

describe("resolveStage: named chain", () => {
  it("resolves stage.agent -> agent.runtime -> agent.model via the stores", () => {
    const stage: StageDefinition = { name: "main", gate: "auto", agent: "worker" };
    const resolved = resolveStage(app, fakeSession, stage);
    expect(resolved.agent.name).toBe("worker");
    expect(resolved.runtime.name).toBe("claude-agent");
    expect(resolved.model.id).toBe("claude-sonnet-4-6");
    expect(resolved.resolvedSlug).toBe("claude-sonnet-4-6");
  });
});

describe("resolveStage: inline agent with named runtime + named model", () => {
  it("uses inline agent's system prompt + named refs", () => {
    const stage: StageDefinition = {
      name: "custom",
      gate: "auto",
      agent: {
        runtime: "claude-agent",
        model: "opus",
        system_prompt: "You are an inline agent.",
      },
    };
    const resolved = resolveStage(app, fakeSession, stage);
    expect(resolved.agent.system_prompt).toBe("You are an inline agent.");
    expect(resolved.runtime.name).toBe("claude-agent");
    expect(resolved.model.id).toBe("claude-opus-4-7");
  });
});

describe("resolveStage: inline model with provider_slugs", () => {
  it("uses the inline model's provider_slugs for slug resolution", () => {
    const stage: StageDefinition = {
      name: "bespoke-model",
      gate: "auto",
      agent: {
        runtime: "claude-agent",
        model: {
          id: "my-custom",
          display: "Custom",
          provider: "anthropic",
          provider_slugs: { "anthropic-direct": "my-direct", "tf-bedrock": "my-bedrock" },
        },
        system_prompt: "inline w/ inline model",
      },
    };
    const resolved = resolveStage(app, fakeSession, stage);
    expect(resolved.model.id).toBe("my-custom");
    expect(resolved.resolvedSlug).toBe("my-direct");
  });
});

describe("resolveStage: inline runtime", () => {
  it("materializes an inline runtime and resolves its model by name", () => {
    const stage: StageDefinition = {
      name: "bespoke-runtime",
      gate: "auto",
      agent: {
        runtime: { name: "my-rt", type: "claude-agent" },
        model: "sonnet",
        system_prompt: "inline runtime",
      },
    };
    const resolved = resolveStage(app, fakeSession, stage);
    expect(resolved.runtime.name).toBe("my-rt");
    expect(resolved.model.id).toBe("claude-sonnet-4-6");
  });
});

describe("resolveStage: fully mixed tree", () => {
  it("allows inline agent + inline runtime + inline model in one call", () => {
    const stage: StageDefinition = {
      name: "full-inline",
      gate: "auto",
      agent: {
        runtime: { name: "inline-rt", type: "claude-agent" },
        model: {
          id: "inline-model",
          display: "Inline Model",
          provider: "anthropic",
          provider_slugs: { "anthropic-direct": "mm-direct" },
        },
        system_prompt: "full inline",
      },
    };
    const resolved = resolveStage(app, fakeSession, stage);
    expect(resolved.runtime.name).toBe("inline-rt");
    expect(resolved.model.id).toBe("inline-model");
    expect(resolved.resolvedSlug).toBe("mm-direct");
  });
});

describe("resolveStage: error paths", () => {
  it("throws a clean error when the named agent is missing", () => {
    const stage: StageDefinition = { name: "x", gate: "auto", agent: "no-such-agent" };
    try {
      resolveStage(app, fakeSession, stage);
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.message).toContain('Agent "no-such-agent" not found');
    }
  });

  it("throws when the named runtime is missing", () => {
    const stage: StageDefinition = {
      name: "x",
      gate: "auto",
      agent: {
        runtime: "no-such-runtime",
        model: "sonnet",
        system_prompt: "hi",
      },
    };
    try {
      resolveStage(app, fakeSession, stage);
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.message).toContain('Runtime "no-such-runtime" not found');
    }
  });

  it("throws when the named model is missing", () => {
    const stage: StageDefinition = {
      name: "x",
      gate: "auto",
      agent: {
        runtime: "claude-agent",
        model: "no-such-model",
        system_prompt: "hi",
      },
    };
    try {
      resolveStage(app, fakeSession, stage);
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.message).toContain('Model "no-such-model" not found');
    }
  });

  it("throws when an inline agent has no model and the agent lacks one too", () => {
    const stage: StageDefinition = {
      name: "x",
      gate: "auto",
      agent: {
        runtime: "claude-agent",
        system_prompt: "hi",
      },
    };
    try {
      resolveStage(app, fakeSession, stage);
      throw new Error("expected throw");
    } catch (e: any) {
      expect(e.message).toContain("has no model");
    }
  });
});
