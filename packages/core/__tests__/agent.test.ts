/**
 * Tests for agent.ts — CRUD, template resolution, CLI arg building.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import {
  loadAgent, listAgents, saveAgent, deleteAgent,
  resolveAgent, buildClaudeArgs,
  type AgentDefinition,
} from "../agent.js";
import { ARK_DIR } from "../store.js";

let ctx: TestContext;
const agentDir = () => join(ARK_DIR, "agents");

function writeAgentYaml(name: string, data: Record<string, unknown>) {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(join(agentDir(), `${name}.yaml`), YAML.stringify(data));
}

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
  // Clean user agent dir to prevent leaking between tests
  rmSync(agentDir(), { recursive: true, force: true });
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

// ── loadAgent ────────────────────────────────────────────────────────────────

describe("loadAgent", () => {
  it("returns null for non-existent agent", () => {
    expect(loadAgent("does-not-exist")).toBeNull();
  });

  it("loads a user agent from YAML", () => {
    writeAgentYaml("my-agent", {
      name: "my-agent",
      description: "A test agent",
      model: "opus",
      system_prompt: "You are helpful.",
    });

    const agent = loadAgent("my-agent");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("my-agent");
    expect(agent!.description).toBe("A test agent");
    expect(agent!.model).toBe("opus");
    expect(agent!.system_prompt).toBe("You are helpful.");
  });

  it("fills defaults for missing fields", () => {
    writeAgentYaml("minimal", { name: "minimal" });

    const agent = loadAgent("minimal");
    expect(agent).not.toBeNull();
    expect(agent!.model).toBe("sonnet");
    expect(agent!.max_turns).toBe(200);
    expect(agent!.tools).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
    expect(agent!.mcp_servers).toEqual([]);
    expect(agent!.skills).toEqual([]);
    expect(agent!.memories).toEqual([]);
    expect(agent!.context).toEqual([]);
    expect(agent!.permission_mode).toBe("bypassPermissions");
    expect(agent!.env).toEqual({});
    expect(agent!.description).toBe("");
    expect(agent!.system_prompt).toBe("");
  });

  it("marks user agents with _source 'user'", () => {
    writeAgentYaml("tagged", { name: "tagged" });

    const agent = loadAgent("tagged");
    expect(agent!._source).toBe("user");
  });

  it("sets _path to the YAML file path", () => {
    writeAgentYaml("pathed", { name: "pathed" });

    const agent = loadAgent("pathed");
    expect(agent!._path).toBe(join(agentDir(), "pathed.yaml"));
  });

  it("loads a builtin agent (e.g. worker)", () => {
    // The builtin agents dir should have worker.yaml from the repo
    const agent = loadAgent("worker");
    expect(agent).not.toBeNull();
    expect(agent!.name).toBe("worker");
    expect(agent!._source).toBe("builtin");
  });

  it("user agent overrides builtin with same name", () => {
    writeAgentYaml("worker", {
      name: "worker",
      description: "My custom worker",
      model: "haiku",
    });

    const agent = loadAgent("worker");
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("user");
    expect(agent!.description).toBe("My custom worker");
    expect(agent!.model).toBe("haiku");
  });
});

// ── listAgents ───────────────────────────────────────────────────────────────

describe("listAgents", () => {
  it("lists builtin agents when no user agents exist", () => {
    const agents = listAgents();
    // Should include at least the builtin agents from agents/ dir
    expect(agents.length).toBeGreaterThan(0);
    const names = agents.map(a => a.name);
    expect(names).toContain("worker");
    expect(names).toContain("planner");
  });

  it("includes user agents in listing", () => {
    writeAgentYaml("custom-one", { name: "custom-one", description: "First" });
    writeAgentYaml("custom-two", { name: "custom-two", description: "Second" });

    const agents = listAgents();
    const names = agents.map(a => a.name);
    expect(names).toContain("custom-one");
    expect(names).toContain("custom-two");
  });

  it("user agent overrides builtin with same name in listing", () => {
    writeAgentYaml("worker", {
      name: "worker",
      description: "Override",
    });

    const agents = listAgents();
    const worker = agents.find(a => a.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!._source).toBe("user");
    expect(worker!.description).toBe("Override");
  });

  it("fills defaults for agents in listing", () => {
    writeAgentYaml("sparse", { name: "sparse" });

    const agents = listAgents();
    const sparse = agents.find(a => a.name === "sparse");
    expect(sparse).toBeDefined();
    expect(sparse!.model).toBe("sonnet");
    expect(sparse!.max_turns).toBe(200);
  });
});

// ── saveAgent ────────────────────────────────────────────────────────────────

describe("saveAgent", () => {
  it("round-trip: save then reload", () => {
    const agent: AgentDefinition = {
      name: "saved-agent",
      description: "Saved description",
      model: "opus",
      max_turns: 50,
      system_prompt: "You are a saved agent.",
      tools: ["Bash", "Read"],
      mcp_servers: [],
      skills: ["skill-a"],
      memories: ["mem-1"],
      context: ["ctx-file"],
      permission_mode: "bypassPermissions",
      env: { FOO: "bar" },
    };

    saveAgent(agent);

    const loaded = loadAgent("saved-agent");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("saved-agent");
    expect(loaded!.description).toBe("Saved description");
    expect(loaded!.model).toBe("opus");
    expect(loaded!.max_turns).toBe(50);
    expect(loaded!.system_prompt).toBe("You are a saved agent.");
    expect(loaded!.tools).toEqual(["Bash", "Read"]);
    expect(loaded!.skills).toEqual(["skill-a"]);
    expect(loaded!.memories).toEqual(["mem-1"]);
    expect(loaded!.context).toEqual(["ctx-file"]);
    expect(loaded!.env).toEqual({ FOO: "bar" });
  });

  it("creates agent directory if it does not exist", () => {
    rmSync(agentDir(), { recursive: true, force: true });

    saveAgent({
      name: "new-agent",
      description: "",
      model: "sonnet",
      max_turns: 200,
      system_prompt: "",
      tools: [],
      mcp_servers: [],
      skills: [],
      memories: [],
      context: [],
      permission_mode: "bypassPermissions",
      env: {},
    });

    expect(existsSync(join(agentDir(), "new-agent.yaml"))).toBe(true);
  });

  it("strips _source and _path from saved YAML", () => {
    const agent: AgentDefinition = {
      name: "stripped",
      description: "",
      model: "sonnet",
      max_turns: 200,
      system_prompt: "",
      tools: [],
      mcp_servers: [],
      skills: [],
      memories: [],
      context: [],
      permission_mode: "bypassPermissions",
      env: {},
      _source: "user",
      _path: "/some/path",
    };

    saveAgent(agent);

    const raw = YAML.parse(
      require("fs").readFileSync(join(agentDir(), "stripped.yaml"), "utf-8"),
    );
    expect(raw._source).toBeUndefined();
    expect(raw._path).toBeUndefined();
  });
});

// ── deleteAgent ──────────────────────────────────────────────────────────────

describe("deleteAgent", () => {
  it("returns false for non-existent agent", () => {
    expect(deleteAgent("ghost")).toBe(false);
  });

  it("returns true and removes the file", () => {
    writeAgentYaml("to-delete", { name: "to-delete" });
    expect(existsSync(join(agentDir(), "to-delete.yaml"))).toBe(true);

    const result = deleteAgent("to-delete");
    expect(result).toBe(true);
    expect(existsSync(join(agentDir(), "to-delete.yaml"))).toBe(false);
  });

  it("agent is no longer loadable after deletion", () => {
    writeAgentYaml("ephemeral", { name: "ephemeral" });
    expect(loadAgent("ephemeral")).not.toBeNull();

    deleteAgent("ephemeral");
    // Should fall through to builtin lookup (which won't find "ephemeral")
    expect(loadAgent("ephemeral")).toBeNull();
  });
});

// ── resolveAgent ─────────────────────────────────────────────────────────────

describe("resolveAgent", () => {
  it("returns null for unknown agent", () => {
    expect(resolveAgent("nonexistent", {})).toBeNull();
  });

  it("substitutes template vars in system_prompt", () => {
    writeAgentYaml("templated", {
      name: "templated",
      system_prompt: "Working on {ticket}: {summary} in {repo} on branch {branch}.",
    });

    const agent = resolveAgent("templated", {
      ticket: "PROJ-123",
      summary: "Fix the bug",
      repo: "/code/myrepo",
      branch: "feat/fix-bug",
    });

    expect(agent).not.toBeNull();
    expect(agent!.system_prompt).toBe(
      "Working on PROJ-123: Fix the bug in /code/myrepo on branch feat/fix-bug.",
    );
  });

  it("substitutes workdir, track_id, and stage vars", () => {
    writeAgentYaml("vars-agent", {
      name: "vars-agent",
      system_prompt: "Dir: {workdir}, Track: {track_id}, Stage: {stage}",
    });

    const agent = resolveAgent("vars-agent", {
      workdir: "/tmp/work",
      id: "s-abc123",
      stage: "implement",
    });

    expect(agent!.system_prompt).toBe(
      "Dir: /tmp/work, Track: s-abc123, Stage: implement",
    );
  });

  it("substitutes backward-compat jira_key and jira_summary", () => {
    writeAgentYaml("compat-agent", {
      name: "compat-agent",
      system_prompt: "Ticket: {jira_key}, Summary: {jira_summary}",
    });

    const agent = resolveAgent("compat-agent", {
      ticket: "JIRA-456",
      summary: "Do the thing",
    });

    expect(agent!.system_prompt).toBe(
      "Ticket: JIRA-456, Summary: Do the thing",
    );
  });

  it("preserves unknown template vars", () => {
    writeAgentYaml("unknown-vars", {
      name: "unknown-vars",
      system_prompt: "Known: {ticket}, Unknown: {custom_var}",
    });

    const agent = resolveAgent("unknown-vars", { ticket: "T-1" });
    expect(agent!.system_prompt).toBe("Known: T-1, Unknown: {custom_var}");
  });

  it("handles empty session — vars resolve to empty strings", () => {
    writeAgentYaml("empty-session", {
      name: "empty-session",
      system_prompt: "Ticket={ticket}, Repo={repo}",
    });

    const agent = resolveAgent("empty-session", {});
    expect(agent!.system_prompt).toBe("Ticket=, Repo=");
  });

  it("handles agent with no system_prompt", () => {
    writeAgentYaml("no-prompt", { name: "no-prompt" });

    const agent = resolveAgent("no-prompt", { ticket: "X-1" });
    expect(agent).not.toBeNull();
    expect(agent!.system_prompt).toBe("");
  });

  it("workdir defaults to '.' when not provided", () => {
    writeAgentYaml("workdir-default", {
      name: "workdir-default",
      system_prompt: "Dir: {workdir}",
    });

    const agent = resolveAgent("workdir-default", {});
    expect(agent!.system_prompt).toBe("Dir: .");
  });
});

// ── buildClaudeArgs ──────────────────────────────────────────────────────────

describe("buildClaudeArgs", () => {
  const baseAgent: AgentDefinition = {
    name: "test-agent",
    description: "Test",
    model: "sonnet",
    max_turns: 100,
    system_prompt: "Be helpful.",
    tools: ["Bash", "Read"],
    mcp_servers: [],
    skills: [],
    memories: [],
    context: [],
    permission_mode: "bypassPermissions",
    env: {},
  };

  it("starts with 'claude' as first arg", () => {
    const args = buildClaudeArgs(baseAgent);
    expect(args[0]).toBe("claude");
  });

  it("includes --model with resolved model name", () => {
    const args = buildClaudeArgs(baseAgent);
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  it("includes --max-turns from agent", () => {
    const args = buildClaudeArgs(baseAgent);
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("100");
  });

  it("includes --append-system-prompt from agent", () => {
    const args = buildClaudeArgs(baseAgent);
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Be helpful.");
  });

  it("passes --session-id from opts", () => {
    const args = buildClaudeArgs(baseAgent, { sessionId: "sess-1" });
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-1");
  });

  it("passes headless and task options", () => {
    const args = buildClaudeArgs(baseAgent, {
      headless: true,
      task: "Run the tests",
    });
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("Run the tests");
    expect(args).toContain("--verbose");
    expect(args).toContain("--output-format");
  });

  it("includes --dangerously-skip-permissions in non-headless mode", () => {
    const args = buildClaudeArgs(baseAgent);
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("adds --mcp-config for each MCP server entry", () => {
    const agent: AgentDefinition = {
      ...baseAgent,
      mcp_servers: ["/path/a.json", { command: "node", args: ["s.js"] }],
    };
    const args = buildClaudeArgs(agent);
    const mcpIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--mcp-config") acc.push(i);
      return acc;
    }, []);
    expect(mcpIndices.length).toBe(2);
    expect(args[mcpIndices[0] + 1]).toBe("/path/a.json");
    expect(args[mcpIndices[1] + 1]).toBe(JSON.stringify({ command: "node", args: ["s.js"] }));
  });

  it("does not include -p without headless mode", () => {
    const args = buildClaudeArgs(baseAgent, { task: "ignored" });
    expect(args).not.toContain("-p");
  });
});
