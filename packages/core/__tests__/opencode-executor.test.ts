/**
 * Unit tests for the opencode executor's pure builders.
 *
 * buildOpenCodeCommand and buildOpenCodeConfig are pure functions that
 * produce the CLI argv and config object. These tests pin the shape so
 * refactors don't silently break the integration.
 */

import { describe, it, expect } from "bun:test";
import { buildOpenCodeCommand, buildOpenCodeConfig } from "../executors/opencode.js";

// -- buildOpenCodeCommand -----------------------------------------------------

describe("buildOpenCodeCommand", () => {
  it("uses 'opencode' binary by default", () => {
    const argv = buildOpenCodeCommand({ task: "hello" });
    expect(argv[0]).toBe("opencode");
  });

  it("can be pointed at a custom binary path", () => {
    const argv = buildOpenCodeCommand({ task: "hello", binaryPath: "/usr/local/bin/opencode" });
    expect(argv[0]).toBe("/usr/local/bin/opencode");
  });

  it("always passes -q for quiet (non-interactive) mode", () => {
    const argv = buildOpenCodeCommand({ task: "hello" });
    expect(argv).toContain("-q");
  });

  it("passes -p with the task text", () => {
    const argv = buildOpenCodeCommand({ task: "Fix the failing test in parser.ts" });
    expect(argv).toContain("-p");
    expect(argv[argv.indexOf("-p") + 1]).toBe("Fix the failing test in parser.ts");
  });

  it("produces correct full argv for a typical task", () => {
    const argv = buildOpenCodeCommand({ task: "Implement the feature" });
    expect(argv).toEqual(["opencode", "-q", "-p", "Implement the feature"]);
  });

  it("handles empty task string", () => {
    const argv = buildOpenCodeCommand({ task: "" });
    expect(argv).toEqual(["opencode", "-q", "-p", ""]);
  });

  it("handles task with special characters", () => {
    const argv = buildOpenCodeCommand({ task: "Fix the bug in `parser.ts` with $PATH" });
    expect(argv[argv.indexOf("-p") + 1]).toBe("Fix the bug in `parser.ts` with $PATH");
  });
});

// -- buildOpenCodeConfig ------------------------------------------------------

describe("buildOpenCodeConfig", () => {
  it("sets model for coder and task agents", () => {
    const config = buildOpenCodeConfig({ model: "claude-sonnet-4-6" });
    expect((config.agents as any).coder.model).toBe("claude-sonnet-4-6");
    expect((config.agents as any).task.model).toBe("claude-sonnet-4-6");
  });

  it("injects MCP servers", () => {
    const mcpServers = {
      "ark-channel": {
        type: "stdio",
        command: "bun",
        args: ["run", "channel.ts"],
        env: { ARK_SESSION_ID: "s-1" },
      },
    };
    const config = buildOpenCodeConfig({ mcpServers });
    expect((config.mcpServers as any)["ark-channel"].type).toBe("stdio");
    expect((config.mcpServers as any)["ark-channel"].command).toBe("bun");
  });

  it("merges with existing config preserving user settings", () => {
    const existing = {
      agents: { coder: { maxTokens: 8000 }, summarizer: { model: "gpt-4o-mini" } },
      mcpServers: { "user-mcp": { type: "stdio", command: "user-tool" } },
      theme: "dark",
    };
    const config = buildOpenCodeConfig(
      {
        model: "claude-opus-4-6",
        mcpServers: { "ark-channel": { type: "stdio", command: "bun" } },
      },
      existing,
    );

    // Ark model config is set
    expect((config.agents as any).coder.model).toBe("claude-opus-4-6");
    // Existing agent settings preserved (summarizer)
    expect((config.agents as any).summarizer.model).toBe("gpt-4o-mini");
    // Existing coder settings merged (maxTokens preserved)
    expect((config.agents as any).coder.maxTokens).toBe(8000);
    // User MCP server preserved
    expect((config.mcpServers as any)["user-mcp"].command).toBe("user-tool");
    // Ark channel injected
    expect((config.mcpServers as any)["ark-channel"].command).toBe("bun");
    // Other top-level config preserved
    expect(config.theme).toBe("dark");
  });

  it("returns empty config when no opts provided", () => {
    const config = buildOpenCodeConfig({});
    expect(config).toEqual({});
  });

  it("skips mcpServers when empty object is provided", () => {
    const config = buildOpenCodeConfig({ mcpServers: {} });
    expect(config.mcpServers).toBeUndefined();
  });
});

// -- Plugin discovery (reuse) -------------------------------------------------

describe("loadPluginExecutors", () => {
  it("returns an empty array when the plugin dir does not exist", async () => {
    const { loadPluginExecutors } = await import("../executors/index.js");
    const result = await loadPluginExecutors("/nonexistent/ark/dir");
    expect(result).toEqual([]);
  });
});

// -- Barrel -------------------------------------------------------------------

describe("builtinExecutors", () => {
  it("includes claude-code, subprocess, cli-agent, goose, and opencode", async () => {
    const { builtinExecutors } = await import("../executors/index.js");
    const names = builtinExecutors.map((e) => e.name).sort();
    expect(names).toEqual(["claude-code", "cli-agent", "goose", "opencode", "subprocess"]);
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
