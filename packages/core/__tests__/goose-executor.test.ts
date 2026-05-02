/**
 * Unit tests for the goose executor's pure command-line builder.
 *
 * buildGooseCommand is a pure function that takes an agent spec, a task,
 * and optional recipe/channel config and returns the argv to exec. These
 * tests pin the shape so refactors don't silently break the flags we pass
 * to goose.
 */

import { describe, it, expect } from "bun:test";
import { buildGooseCommand } from "../executors/goose.js";
import type { LaunchOpts } from "../executor.js";

function makeAgent(overrides: Partial<LaunchOpts["agent"]> = {}): LaunchOpts["agent"] {
  return {
    name: "test",
    model: "claude-sonnet-4-6",
    max_turns: 50,
    system_prompt: "",
    tools: [],
    skills: [],
    mcp_servers: [],
    permission_mode: "bypassPermissions",
    env: {},
    ...overrides,
  };
}

describe("buildGooseCommand", () => {
  it("uses the `goose` binary by default", () => {
    const argv = buildGooseCommand({ agent: makeAgent(), task: "hello", sessionId: "s-1" });
    expect(argv[0]).toBe("goose");
    expect(argv[1]).toBe("run");
  });

  it("can be pointed at a custom binary path (bundled goose)", () => {
    const argv = buildGooseCommand({
      agent: makeAgent(),
      task: "hello",
      sessionId: "s-1",
      binaryPath: "/usr/local/share/ark/bin/goose",
    });
    expect(argv[0]).toBe("/usr/local/share/ark/bin/goose");
  });

  it("always passes --no-session", () => {
    const argv = buildGooseCommand({ agent: makeAgent(), task: "hello", sessionId: "s-1" });
    expect(argv).toContain("--no-session");
  });

  it("passes --model from agent.model", () => {
    const argv = buildGooseCommand({
      agent: makeAgent({ model: "claude-opus-4-6" }),
      task: "hello",
      sessionId: "s-1",
    });
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-4-6");
  });

  it("passes --max-turns from agent.max_turns", () => {
    const argv = buildGooseCommand({
      agent: makeAgent({ max_turns: 25 }),
      task: "hello",
      sessionId: "s-1",
    });
    expect(argv).toContain("--max-turns");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("25");
  });

  it("omits --max-turns when agent.max_turns is zero", () => {
    const argv = buildGooseCommand({
      agent: makeAgent({ max_turns: 0 }),
      task: "hello",
      sessionId: "s-1",
    });
    expect(argv).not.toContain("--max-turns");
  });

  it("wires the channel MCP as --with-extension when provided", () => {
    const argv = buildGooseCommand({
      agent: makeAgent(),
      task: "hello",
      sessionId: "s-1",
      channelExtension: {
        command: "/Users/me/.bun/bin/bun",
        args: ["/ark/core/claude/channel.ts"],
      },
    });
    expect(argv).toContain("--with-extension");
    const extValue = argv[argv.indexOf("--with-extension") + 1];
    expect(extValue).toBe("/Users/me/.bun/bin/bun /ark/core/claude/channel.ts");
  });

  it("defaults to -t text delivery when no recipe is set", () => {
    const argv = buildGooseCommand({
      agent: makeAgent(),
      task: "Implement the widget",
      sessionId: "s-1",
    });
    expect(argv).toContain("-t");
    expect(argv[argv.indexOf("-t") + 1]).toBe("Implement the widget");
    expect(argv).not.toContain("--recipe");
  });

  it("uses --recipe delivery when agent.recipe is set and skips -t", () => {
    const argv = buildGooseCommand({
      agent: makeAgent({ recipe: "/repo/recipes/islc-orchestrate.yaml" }),
      task: "ignored when recipe is set",
      sessionId: "s-1",
    });
    expect(argv).toContain("--recipe");
    expect(argv[argv.indexOf("--recipe") + 1]).toBe("/repo/recipes/islc-orchestrate.yaml");
    expect(argv).not.toContain("-t");
  });

  it("passes every sub-recipe as --sub-recipe when agent.sub_recipes is set", () => {
    const argv = buildGooseCommand({
      agent: makeAgent({
        recipe: "/repo/recipes/islc-orchestrate.yaml",
        sub_recipes: ["/repo/recipes/islc-plan.yaml", "/repo/recipes/islc-execute.yaml"],
      }),
      task: "",
      sessionId: "s-1",
    });
    const subs = argv.reduce<string[]>((acc, flag, i) => {
      if (flag === "--sub-recipe") acc.push(argv[i + 1]);
      return acc;
    }, []);
    expect(subs).toEqual(["/repo/recipes/islc-plan.yaml", "/repo/recipes/islc-execute.yaml"]);
  });

  it("passes every recipe param as --params k=v when agent has a recipe", () => {
    const argv = buildGooseCommand({
      agent: makeAgent({ recipe: "/repo/recipes/main.yaml" }),
      task: "",
      sessionId: "s-1",
      params: { ticket: "IN-57970", summary: "Fix widget", workdir: "/tmp/wt" },
    });
    const params = argv.reduce<string[]>((acc, flag, i) => {
      if (flag === "--params") acc.push(argv[i + 1]);
      return acc;
    }, []);
    expect(params).toContain("ticket=IN-57970");
    expect(params).toContain("summary=Fix widget");
    expect(params).toContain("workdir=/tmp/wt");
  });

  it("does not emit --params in text-delivery mode even if params are passed", () => {
    const argv = buildGooseCommand({
      agent: makeAgent(),
      task: "hello",
      sessionId: "s-1",
      params: { ticket: "IN-57970" },
    });
    expect(argv).not.toContain("--params");
  });

  it("passes -s when interactive is true (manual gate)", () => {
    const argv = buildGooseCommand({
      agent: makeAgent(),
      task: "Fix the tests",
      sessionId: "s-1",
      interactive: true,
    });
    expect(argv).toContain("-s");
    // Still delivers the task via -t
    expect(argv).toContain("-t");
    expect(argv[argv.indexOf("-t") + 1]).toBe("Fix the tests");
  });

  it("omits -s when interactive is false or unset (auto gate)", () => {
    const argv = buildGooseCommand({
      agent: makeAgent(),
      task: "Run and exit",
      sessionId: "s-1",
      interactive: false,
    });
    expect(argv).not.toContain("-s");
  });

  it("includes -t with the task text for auto-start dispatch", () => {
    const argv = buildGooseCommand({
      agent: makeAgent(),
      task: "Implement the feature end-to-end",
      sessionId: "s-42",
    });
    expect(argv).toContain("-t");
    expect(argv[argv.indexOf("-t") + 1]).toBe("Implement the feature end-to-end");
  });
});

// ── Plugin discovery ──────────────────────────────────────────────────────

describe("loadPluginExecutors", async () => {
  it("returns an empty array when the plugin dir does not exist", async () => {
    const { loadPluginExecutors } = await import("../executors/index.js");
    const result = await loadPluginExecutors("/nonexistent/ark/dir");
    expect(result).toEqual([]);
  });
});

// ── Barrel ────────────────────────────────────────────────────────────────

describe("builtinExecutors", async () => {
  it("includes claude-agent, claude-code, cli-agent, goose, and subprocess", async () => {
    const { builtinExecutors } = await import("../executors/index.js");
    const names = builtinExecutors.map((e) => e.name).sort();
    expect(names).toEqual(["claude-agent", "claude-code", "cli-agent", "goose", "subprocess"]);
  });

  it("every builtin executor exposes the Executor interface", async () => {
    const { builtinExecutors } = await import("../executors/index.js");
    for (const ex of builtinExecutors) {
      expect(typeof ex.launch).toBe("function");
      expect(typeof ex.kill).toBe("function");
      expect(typeof ex.status).toBe("function");
      expect(typeof ex.send).toBe("function");
      expect(typeof ex.capture).toBe("function");
    }
  });
});
