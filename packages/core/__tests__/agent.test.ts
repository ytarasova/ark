/**
 * Tests for agent.ts — CRUD, template resolution, CLI arg building.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import {
  loadAgent, listAgents, saveAgent, deleteAgent,
  resolveAgent, buildClaudeArgs, findProjectRoot,
  type AgentDefinition,
} from "../agent.js";
import { ARK_DIR } from "../store.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();

const agentDir = () => join(ARK_DIR(), "agents");

function writeAgentYaml(name: string, data: Record<string, unknown>) {
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(join(agentDir(), `${name}.yaml`), YAML.stringify(data));
}

const projectDir = () => getCtx().arkDir;

function writeProjectAgentYaml(name: string, data: Record<string, unknown>) {
  const dir = join(projectDir(), ".ark", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(data));
}

beforeEach(() => {
  // Clean user agent dir to prevent leaking between tests
  rmSync(agentDir(), { recursive: true, force: true });
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

  it("marks global agents with _source 'global'", () => {
    writeAgentYaml("tagged", { name: "tagged" });

    const agent = loadAgent("tagged");
    expect(agent!._source).toBe("global");
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

  it("global agent overrides builtin with same name", () => {
    writeAgentYaml("worker", {
      name: "worker",
      description: "My custom worker",
      model: "haiku",
    });

    const agent = loadAgent("worker");
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("global");
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

  it("global agent overrides builtin with same name in listing", () => {
    writeAgentYaml("worker", {
      name: "worker",
      description: "Override",
    });

    const agents = listAgents();
    const worker = agents.find(a => a.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!._source).toBe("global");
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
      _source: "global",
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

// ── findProjectRoot ─────────────────────────────────────────────────────────

describe("findProjectRoot", () => {
  it("finds .git walking up from subdirectory", () => {
    // The test is running inside a git repo, so findProjectRoot from cwd should find it
    const root = findProjectRoot(process.cwd());
    expect(root).not.toBeNull();
    expect(existsSync(join(root!, ".git"))).toBe(true);
  });

  it("returns null when no .git exists", () => {
    // /tmp is unlikely to be inside a git repo
    const root = findProjectRoot("/tmp");
    expect(root).toBeNull();
  });

  it("finds .git in exact directory", () => {
    const tmpDir = join(getCtx().arkDir, "fake-project");
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    expect(findProjectRoot(tmpDir)).toBe(tmpDir);
  });

  it("finds .git from nested subdirectory", () => {
    const tmpDir = join(getCtx().arkDir, "fake-project2");
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    const nested = join(tmpDir, "src", "deep");
    mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(tmpDir);
  });
});

// ── Three-tier resolution ───────────────────────────────────────────────────

describe("three-tier resolution", () => {
  it("project agent overrides global agent", () => {
    writeAgentYaml("my-agent", { name: "my-agent", description: "global" });
    writeProjectAgentYaml("my-agent", { name: "my-agent", description: "project" });

    const agent = loadAgent("my-agent", projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("project");
    expect(agent!.description).toBe("project");
  });

  it("project agent overrides builtin agent", () => {
    writeProjectAgentYaml("worker", { name: "worker", description: "project worker" });

    const agent = loadAgent("worker", projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("project");
    expect(agent!.description).toBe("project worker");
  });

  it("global agent overrides builtin when no project agent", () => {
    writeAgentYaml("worker", { name: "worker", description: "global worker" });

    const agent = loadAgent("worker", projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("global");
    expect(agent!.description).toBe("global worker");
  });

  it("falls back to builtin when no project or global agent", () => {
    const agent = loadAgent("worker", projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("builtin");
  });

  it("without projectRoot, skips project tier", () => {
    writeProjectAgentYaml("only-project", { name: "only-project", description: "project only" });

    // Without projectRoot, should not find project-only agent
    const agent = loadAgent("only-project");
    expect(agent).toBeNull();
  });
});

// ── listAgents with projectRoot ─────────────────────────────────────────────

describe("listAgents with projectRoot", () => {
  it("merges all three tiers", () => {
    writeAgentYaml("global-only", { name: "global-only", description: "global" });
    writeProjectAgentYaml("project-only", { name: "project-only", description: "project" });

    const agents = listAgents(projectDir());
    const names = agents.map(a => a.name);
    expect(names).toContain("worker"); // builtin
    expect(names).toContain("global-only"); // global
    expect(names).toContain("project-only"); // project
  });

  it("project agent wins over global and builtin", () => {
    writeAgentYaml("worker", { name: "worker", description: "global worker" });
    writeProjectAgentYaml("worker", { name: "worker", description: "project worker" });

    const agents = listAgents(projectDir());
    const worker = agents.find(a => a.name === "worker");
    expect(worker).toBeDefined();
    expect(worker!._source).toBe("project");
    expect(worker!.description).toBe("project worker");
  });

  it("without projectRoot, does not include project agents", () => {
    writeProjectAgentYaml("project-only", { name: "project-only" });

    const agents = listAgents();
    const names = agents.map(a => a.name);
    expect(names).not.toContain("project-only");
  });
});

// ── saveAgent with scope ────────────────────────────────────────────────────

describe("saveAgent with scope", () => {
  const minAgent: AgentDefinition = {
    name: "scoped-agent",
    description: "test",
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
  };

  it("saves to global by default", () => {
    saveAgent(minAgent);
    expect(existsSync(join(agentDir(), "scoped-agent.yaml"))).toBe(true);
  });

  it("saves to project when scope is 'project'", () => {
    saveAgent(minAgent, "project", projectDir());
    const projectAgentPath = join(projectDir(), ".ark", "agents", "scoped-agent.yaml");
    expect(existsSync(projectAgentPath)).toBe(true);
    // Should NOT exist in global
    expect(existsSync(join(agentDir(), "scoped-agent.yaml"))).toBe(false);
  });

  it("falls back to global when scope is 'project' but no projectRoot", () => {
    saveAgent(minAgent, "project");
    expect(existsSync(join(agentDir(), "scoped-agent.yaml"))).toBe(true);
  });

  it("project-saved agent is loadable with projectRoot", () => {
    saveAgent(minAgent, "project", projectDir());
    const loaded = loadAgent("scoped-agent", projectDir());
    expect(loaded).not.toBeNull();
    expect(loaded!._source).toBe("project");
  });
});

// ── deleteAgent with scope ──────────────────────────────────────────────────

describe("deleteAgent with scope", () => {

  it("deletes from global by default", () => {
    writeAgentYaml("to-delete", { name: "to-delete" });
    expect(deleteAgent("to-delete")).toBe(true);
    expect(existsSync(join(agentDir(), "to-delete.yaml"))).toBe(false);
  });

  it("deletes from project when scope is 'project'", () => {
    writeProjectAgentYaml("proj-del", { name: "proj-del" });
    const projectPath = join(projectDir(), ".ark", "agents", "proj-del.yaml");
    expect(existsSync(projectPath)).toBe(true);

    expect(deleteAgent("proj-del", "project", projectDir())).toBe(true);
    expect(existsSync(projectPath)).toBe(false);
  });

  it("returns false when agent does not exist in specified scope", () => {
    writeAgentYaml("global-only", { name: "global-only" });
    // Try deleting from project scope — should not find it
    expect(deleteAgent("global-only", "project", projectDir())).toBe(false);
    // Global copy should still exist
    expect(existsSync(join(agentDir(), "global-only.yaml"))).toBe(true);
  });
});

// ── resolveAgent with projectRoot ───────────────────────────────────────────

describe("resolveAgent with projectRoot", () => {

  it("resolves project agent with template substitution", () => {
    writeProjectAgentYaml("proj-tmpl", {
      name: "proj-tmpl",
      system_prompt: "Working on {ticket} in {repo}",
    });

    const agent = resolveAgent("proj-tmpl", { ticket: "T-1", repo: "/code" }, projectDir());
    expect(agent).not.toBeNull();
    expect(agent!._source).toBe("project");
    expect(agent!.system_prompt).toBe("Working on T-1 in /code");
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

// ── Integration: full agent lifecycle ───────────────────────────────────────

describe("full agent lifecycle", () => {
  it("create → list → load → delete round-trip for project scope", () => {
    const root = projectDir();
    const agent = { name: "lifecycle-test", description: "Integration test agent", model: "haiku" } as AgentDefinition;
    saveAgent(agent, "project", root);

    const agents = listAgents(root);
    const found = agents.find(a => a.name === "lifecycle-test");
    expect(found).not.toBeNull();
    expect(found!._source).toBe("project");

    const loaded = loadAgent("lifecycle-test", root);
    expect(loaded!.model).toBe("haiku");

    deleteAgent("lifecycle-test", "project", root);
    expect(loadAgent("lifecycle-test", root)).toBeNull();
  });

  it("project agent shadows global agent with same name", () => {
    const root = projectDir();

    saveAgent({ name: "shadow-test", model: "sonnet" } as AgentDefinition, "global");
    saveAgent({ name: "shadow-test", model: "opus" } as AgentDefinition, "project", root);

    const loaded = loadAgent("shadow-test", root);
    expect(loaded!.model).toBe("opus");
    expect(loaded!._source).toBe("project");

    deleteAgent("shadow-test", "project", root);
    const fallback = loadAgent("shadow-test", root);
    expect(fallback!.model).toBe("sonnet");
    expect(fallback!._source).toBe("global");
  });

  it("global agent shadows builtin with same name", () => {
    writeAgentYaml("worker", { name: "worker", model: "haiku", description: "custom worker" });

    const loaded = loadAgent("worker");
    expect(loaded!.model).toBe("haiku");
    expect(loaded!._source).toBe("global");

    deleteAgent("worker", "global");
    const fallback = loadAgent("worker");
    expect(fallback!._source).toBe("builtin");
  });
});
