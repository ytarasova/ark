/**
 * Unified tool discovery — finds ALL tool types in a project directory.
 *
 * Discovers: MCP servers (.mcp.json), commands (.claude/commands/),
 * Claude Code skills (.claude/skills/), CLAUDE.md context,
 * Ark skills (.ark/skills/), and Ark recipes (.ark/recipes/).
 *
 * Also provides CRUD for MCP servers and commands.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import stripJsonComments from "strip-json-comments";
import { getApp } from "./app.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ToolEntry {
  kind: "mcp-server" | "command" | "claude-skill" | "ark-skill" | "ark-recipe" | "context";
  name: string;
  description: string;
  source: string; // file path or "builtin"
  config?: Record<string, unknown>; // MCP server config, etc.
}

// ── JSONC parsing ───────────────────────────────────────────────────────────

function readJsonc(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(stripJsonComments(raw));
}

// ── Discovery ───────────────────────────────────────────────────────────────

function discoverMcpServers(projectDir: string): ToolEntry[] {
  const mcpPath = join(projectDir, ".mcp.json");
  if (!existsSync(mcpPath)) return [];
  try {
    const parsed = readJsonc(mcpPath) as Record<string, any>;
    const servers = parsed.mcpServers ?? {};
    return Object.entries(servers).map(([name, config]) => ({
      kind: "mcp-server" as const,
      name,
      description: (config as Record<string, unknown>).description as string ?? `MCP server: ${name}`,
      source: mcpPath,
      config: config as Record<string, unknown>,
    }));
  } catch (e: any) {
    console.error(`[tools] failed to parse ${mcpPath}:`, e?.message ?? e);
    return [];
  }
}

function discoverCommands(projectDir: string): ToolEntry[] {
  const cmdDir = join(projectDir, ".claude", "commands");
  if (!existsSync(cmdDir)) return [];
  const entries: ToolEntry[] = [];
  for (const file of readdirSync(cmdDir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = readFileSync(join(cmdDir, file), "utf-8");
      const firstLine = content.split("\n")[0]?.trim() ?? "";
      entries.push({
        kind: "command",
        name: basename(file, ".md"),
        description: firstLine.replace(/^#\s*/, "") || `Command: ${basename(file, ".md")}`,
        source: join(cmdDir, file),
      });
    } catch { /* skip unreadable files */ }
  }
  return entries;
}

function discoverClaudeSkills(projectDir: string): ToolEntry[] {
  const skillDir = join(projectDir, ".claude", "skills");
  if (!existsSync(skillDir)) return [];
  const entries: ToolEntry[] = [];
  for (const file of readdirSync(skillDir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const content = readFileSync(join(skillDir, file), "utf-8");
      const firstLine = content.split("\n")[0]?.trim() ?? "";
      entries.push({
        kind: "claude-skill",
        name: basename(file, ".md"),
        description: firstLine.replace(/^#\s*/, "") || `Skill: ${basename(file, ".md")}`,
        source: join(skillDir, file),
      });
    } catch { /* skip unreadable files */ }
  }
  return entries;
}

function discoverContext(projectDir: string): ToolEntry[] {
  const claudeMd = join(projectDir, "CLAUDE.md");
  if (!existsSync(claudeMd)) return [];
  return [{
    kind: "context",
    name: "CLAUDE.md",
    description: "Project context file",
    source: claudeMd,
  }];
}

function discoverArkSkills(projectDir?: string): ToolEntry[] {
  return getApp().skills.list(projectDir).map(s => ({
    kind: "ark-skill" as const,
    name: s.name,
    description: s.description ?? "",
    source: s._source ?? "builtin",
  }));
}

function discoverArkRecipes(projectDir?: string): ToolEntry[] {
  return getApp().recipes.list(projectDir).map(r => ({
    kind: "ark-recipe" as const,
    name: r.name,
    description: r.description ?? "",
    source: r._source ?? "builtin",
  }));
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Discover ALL tool types from a project directory.
 * Returns a unified ToolEntry[] sorted by kind then name.
 */
export function discoverTools(projectDir?: string): ToolEntry[] {
  const entries: ToolEntry[] = [];

  if (projectDir) {
    entries.push(...discoverMcpServers(projectDir));
    entries.push(...discoverCommands(projectDir));
    entries.push(...discoverClaudeSkills(projectDir));
    entries.push(...discoverContext(projectDir));
  }

  entries.push(...discoverArkSkills(projectDir));
  entries.push(...discoverArkRecipes(projectDir));

  // Sort by kind then name
  const kindOrder: Record<string, number> = {
    "mcp-server": 0,
    "command": 1,
    "claude-skill": 2,
    "context": 3,
    "ark-skill": 4,
    "ark-recipe": 5,
  };
  entries.sort((a, b) => {
    const ko = (kindOrder[a.kind] ?? 99) - (kindOrder[b.kind] ?? 99);
    if (ko !== 0) return ko;
    return a.name.localeCompare(b.name);
  });

  return entries;
}

// ── MCP Server CRUD ─────────────────────────────────────────────────────────

/** Add or update an MCP server in the project's .mcp.json. */
export function addMcpServer(projectDir: string, name: string, config: Record<string, unknown>): void {
  const mcpPath = join(projectDir, ".mcp.json");
  let existing: Record<string, any> = {};
  if (existsSync(mcpPath)) {
    try { existing = readJsonc(mcpPath) as Record<string, any>; }
    catch { /* start fresh if parse fails */ }
  }
  if (!existing.mcpServers) existing.mcpServers = {};
  existing.mcpServers[name] = config;
  writeFileSync(mcpPath, JSON.stringify(existing, null, 2));
}

/** Remove an MCP server from the project's .mcp.json. */
export function removeMcpServer(projectDir: string, name: string): void {
  const mcpPath = join(projectDir, ".mcp.json");
  if (!existsSync(mcpPath)) return;
  let existing: Record<string, any>;
  try { existing = readJsonc(mcpPath) as Record<string, any>; }
  catch { return; }
  if (!existing.mcpServers) return;
  delete existing.mcpServers[name];
  writeFileSync(mcpPath, JSON.stringify(existing, null, 2));
}

// ── Command CRUD ────────────────────────────────────────────────────────────

/** Add or update a command in the project's .claude/commands/ directory. */
export function addCommand(projectDir: string, name: string, content: string): void {
  const cmdDir = join(projectDir, ".claude", "commands");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(join(cmdDir, `${name}.md`), content);
}

/** Remove a command from the project's .claude/commands/ directory. */
export function removeCommand(projectDir: string, name: string): void {
  const cmdPath = join(projectDir, ".claude", "commands", `${name}.md`);
  if (existsSync(cmdPath)) unlinkSync(cmdPath);
}

/** Get the content of a command, or null if it doesn't exist. */
export function getCommand(projectDir: string, name: string): string | null {
  const cmdPath = join(projectDir, ".claude", "commands", `${name}.md`);
  if (!existsSync(cmdPath)) return null;
  return readFileSync(cmdPath, "utf-8");
}
