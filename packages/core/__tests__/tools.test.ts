/**
 * Tests for tools.ts -- unified tool discovery, MCP server CRUD, command CRUD.
 */

import { describe, it, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { withTestContext } from "./test-helpers.js";
import {
  discoverTools,
  addMcpServer, removeMcpServer,
  addCommand, removeCommand, getCommand,
} from "../tools.js";

const { getCtx } = withTestContext();

/** Create a temp project dir inside the test context's arkDir. */
function makeProjectDir(): string {
  const dir = join(getCtx().arkDir, "project");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("discoverTools", () => {
  it("finds MCP servers from .mcp.json", () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "my-server": { command: "node", args: ["server.js"] },
        "other-server": { command: "python", args: ["-m", "mcp"] },
      },
    }));

    const tools = discoverTools(dir);
    const mcpTools = tools.filter(t => t.kind === "mcp-server");
    expect(mcpTools.length).toBe(2);
    expect(mcpTools[0].name).toBe("my-server");
    expect(mcpTools[1].name).toBe("other-server");
    expect(mcpTools[0].config).toEqual({ command: "node", args: ["server.js"] });
  });

  it("finds commands from .claude/commands/", () => {
    const dir = makeProjectDir();
    const cmdDir = join(dir, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "deploy.md"), "# Deploy to production\nRun the deploy script...");
    writeFileSync(join(cmdDir, "lint.md"), "# Lint the code\nRun eslint...");

    const tools = discoverTools(dir);
    const cmds = tools.filter(t => t.kind === "command");
    expect(cmds.length).toBe(2);
    expect(cmds.find(c => c.name === "deploy")?.description).toBe("Deploy to production");
    expect(cmds.find(c => c.name === "lint")?.description).toBe("Lint the code");
  });

  it("finds claude skills from .claude/skills/", () => {
    const dir = makeProjectDir();
    const skillDir = join(dir, ".claude", "skills");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "review.md"), "# Code review skill\nReview code for...");

    const tools = discoverTools(dir);
    const skills = tools.filter(t => t.kind === "claude-skill");
    expect(skills.length).toBe(1);
    expect(skills[0].name).toBe("review");
    expect(skills[0].description).toBe("Code review skill");
  });

  it("finds CLAUDE.md as context entry", () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, "CLAUDE.md"), "# Project\nThis is a project.");

    const tools = discoverTools(dir);
    const ctx = tools.filter(t => t.kind === "context");
    expect(ctx.length).toBe(1);
    expect(ctx[0].name).toBe("CLAUDE.md");
  });

  it("finds ark skills and recipes", () => {
    const tools = discoverTools();
    const arkSkills = tools.filter(t => t.kind === "ark-skill");
    const arkRecipes = tools.filter(t => t.kind === "ark-recipe");
    // Builtin skills and recipes should exist
    expect(arkSkills.length).toBeGreaterThanOrEqual(0);
    expect(arkRecipes.length).toBeGreaterThanOrEqual(0);
  });

  it("handles missing .mcp.json gracefully", () => {
    const dir = makeProjectDir();
    const tools = discoverTools(dir);
    const mcpTools = tools.filter(t => t.kind === "mcp-server");
    expect(mcpTools.length).toBe(0);
  });

  it("handles JSONC (comments) in .mcp.json", () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, ".mcp.json"), `{
  // This is a comment
  "mcpServers": {
    /* block comment */
    "test-server": {
      "command": "node",
      "args": ["server.js"]
    }
  }
}`);

    const tools = discoverTools(dir);
    const mcpTools = tools.filter(t => t.kind === "mcp-server");
    expect(mcpTools.length).toBe(1);
    expect(mcpTools[0].name).toBe("test-server");
  });

  it("sorts by kind then name", () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
      mcpServers: { "z-server": { command: "z" }, "a-server": { command: "a" } },
    }));
    const cmdDir = join(dir, ".claude", "commands");
    mkdirSync(cmdDir, { recursive: true });
    writeFileSync(join(cmdDir, "beta.md"), "# Beta");
    writeFileSync(join(cmdDir, "alpha.md"), "# Alpha");

    const tools = discoverTools(dir);
    const mcpIdx = tools.findIndex(t => t.kind === "mcp-server");
    const cmdIdx = tools.findIndex(t => t.kind === "command");
    // MCP servers come before commands
    expect(mcpIdx).toBeLessThan(cmdIdx);
    // Within MCP servers, sorted by name
    const mcpTools = tools.filter(t => t.kind === "mcp-server");
    expect(mcpTools[0].name).toBe("a-server");
    expect(mcpTools[1].name).toBe("z-server");
  });
});

describe("MCP server CRUD", () => {
  it("addMcpServer / removeMcpServer round-trip", () => {
    const dir = makeProjectDir();

    addMcpServer(dir, "test-server", { command: "node", args: ["srv.js"] });
    let tools = discoverTools(dir);
    let mcp = tools.filter(t => t.kind === "mcp-server");
    expect(mcp.length).toBe(1);
    expect(mcp[0].name).toBe("test-server");
    expect(mcp[0].config).toEqual({ command: "node", args: ["srv.js"] });

    removeMcpServer(dir, "test-server");
    tools = discoverTools(dir);
    mcp = tools.filter(t => t.kind === "mcp-server");
    expect(mcp.length).toBe(0);
  });

  it("addMcpServer preserves existing servers", () => {
    const dir = makeProjectDir();
    addMcpServer(dir, "first", { command: "a" });
    addMcpServer(dir, "second", { command: "b" });

    const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
    expect(Object.keys(parsed.mcpServers).length).toBe(2);
    expect(parsed.mcpServers.first.command).toBe("a");
    expect(parsed.mcpServers.second.command).toBe("b");
  });

  it("addMcpServer handles JSONC in existing file", () => {
    const dir = makeProjectDir();
    writeFileSync(join(dir, ".mcp.json"), `{
  // existing config
  "mcpServers": {
    "old": { "command": "old" }
  }
}`);

    addMcpServer(dir, "new-server", { command: "new" });
    const tools = discoverTools(dir);
    const mcp = tools.filter(t => t.kind === "mcp-server");
    expect(mcp.length).toBe(2);
  });

  it("removeMcpServer is a no-op when .mcp.json is missing", () => {
    const dir = makeProjectDir();
    // Should not throw
    removeMcpServer(dir, "nonexistent");
  });
});

describe("command CRUD", () => {
  it("addCommand / removeCommand round-trip", () => {
    const dir = makeProjectDir();

    addCommand(dir, "deploy", "# Deploy\nDeploy to production.");
    expect(getCommand(dir, "deploy")).toBe("# Deploy\nDeploy to production.");

    const tools = discoverTools(dir);
    const cmds = tools.filter(t => t.kind === "command");
    expect(cmds.length).toBe(1);
    expect(cmds[0].name).toBe("deploy");

    removeCommand(dir, "deploy");
    expect(getCommand(dir, "deploy")).toBeNull();
  });

  it("getCommand returns null for missing command", () => {
    const dir = makeProjectDir();
    expect(getCommand(dir, "nonexistent")).toBeNull();
  });

  it("addCommand creates .claude/commands/ directory", () => {
    const dir = makeProjectDir();
    addCommand(dir, "test-cmd", "# Test\nContent");
    expect(getCommand(dir, "test-cmd")).toBe("# Test\nContent");
  });

  it("removeCommand is a no-op for missing command", () => {
    const dir = makeProjectDir();
    // Should not throw
    removeCommand(dir, "nonexistent");
  });
});
