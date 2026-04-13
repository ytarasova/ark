/**
 * Tests for claude.ts — model mapping, argument building, shell quoting,
 * channel config writing, and launcher generation.
 */

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  MODEL_MAP,
  resolveModel,
  buildArgs,
  shellQuoteArgs,
  channelMcpConfig,
  writeChannelConfig,
  removeChannelConfig,
  buildLauncher,
  trustDirectory,
  type ClaudeArgsOpts,
  type LauncherOpts,
} from "../claude/claude.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();

// ── resolveModel ──────────────────────────────────────────────────────────────

describe("resolveModel", () => {
  it("maps 'opus' to claude-opus-4-6", () => {
    expect(resolveModel("opus")).toBe("claude-opus-4-6");
  });

  it("maps 'sonnet' to claude-sonnet-4-6", () => {
    expect(resolveModel("sonnet")).toBe("claude-sonnet-4-6");
  });

  it("maps 'haiku' to claude-haiku-4-5-20251001", () => {
    expect(resolveModel("haiku")).toBe("claude-haiku-4-5-20251001");
  });

  it("passes through unknown model names unchanged", () => {
    expect(resolveModel("my-custom-model")).toBe("my-custom-model");
  });

  it("MODEL_MAP has exactly opus, sonnet, haiku", () => {
    expect(Object.keys(MODEL_MAP).sort()).toEqual(["haiku", "opus", "sonnet"]);
  });
});

// ── buildArgs ─────────────────────────────────────────────────────────────────

describe("buildArgs", () => {
  it("starts with 'claude' as first arg", () => {
    const args = buildArgs({});
    expect(args[0]).toBe("claude");
  });

  it("adds --model with resolved short name", () => {
    const args = buildArgs({ model: "opus" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-6");
  });

  it("adds --model with full custom model name", () => {
    const args = buildArgs({ model: "claude-custom-v1" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-custom-v1");
  });

  it("adds --dangerously-skip-permissions in non-headless mode", () => {
    const args = buildArgs({});
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("adds --dangerously-skip-permissions in headless mode with task", () => {
    const args = buildArgs({ headless: true, task: "do something" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("adds -p and task in headless mode", () => {
    const args = buildArgs({ headless: true, task: "build the app" });
    expect(args).toContain("-p");
    expect(args[args.indexOf("-p") + 1]).toBe("build the app");
  });

  it("adds --verbose and --output-format stream-json in headless mode", () => {
    const args = buildArgs({ headless: true, task: "run" });
    expect(args).toContain("--verbose");
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  });

  it("does not add -p in non-headless mode even with task", () => {
    const args = buildArgs({ headless: false, task: "hello" });
    expect(args).not.toContain("-p");
  });

  it("adds --session-id when provided", () => {
    const args = buildArgs({ sessionId: "abc-123" });
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("abc-123");
  });

  it("adds --max-turns when provided", () => {
    const args = buildArgs({ maxTurns: 5 });
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("5");
  });

  it("adds --append-system-prompt when systemPrompt provided", () => {
    const args = buildArgs({ systemPrompt: "Be concise" });
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Be concise");
  });

  it("adds --mcp-config for string MCP server entries", () => {
    const args = buildArgs({ mcpServers: ["/path/to/config.json"] });
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/path/to/config.json");
  });

  it("adds --mcp-config with JSON for object MCP server entries", () => {
    const obj = { command: "node", args: ["server.js"] };
    const args = buildArgs({ mcpServers: [obj] });
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(JSON.stringify(obj));
  });

  it("handles multiple MCP servers", () => {
    const args = buildArgs({ mcpServers: ["/a.json", "/b.json"] });
    const indices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--mcp-config") acc.push(i);
      return acc;
    }, []);
    expect(indices.length).toBe(2);
  });

  it("builds minimal args when no options set", () => {
    const args = buildArgs({});
    // Should have claude + --dangerously-skip-permissions
    expect(args[0]).toBe("claude");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args.length).toBe(2);
  });
});

// ── shellQuoteArgs ────────────────────────────────────────────────────────────

describe("shellQuoteArgs", () => {
  it("preserves --flags unquoted", () => {
    const result = shellQuoteArgs(["claude", "--model", "opus"]);
    expect(result).toContain("--model");
    // --model should appear without quotes
    expect(result).not.toContain("'--model'");
  });

  it("quotes values after --flags", () => {
    const result = shellQuoteArgs(["claude", "--model", "opus"]);
    expect(result).toContain("'opus'");
  });

  it("handles single quotes in values", () => {
    const result = shellQuoteArgs(["claude", "--append-system-prompt", "don't stop"]);
    // POSIX shell escaping: 'don'\''t stop'
    expect(result).toContain("don'\\''t stop");
  });

  it("leaves first arg (command) unquoted", () => {
    const result = shellQuoteArgs(["claude"]);
    expect(result).toBe("claude");
  });

  it("leaves standalone non-flag args unquoted when not preceded by a flag", () => {
    const result = shellQuoteArgs(["claude", "-p", "my task"]);
    // -p is a short flag (does not start with --) so it gets left as-is
    // "my task" follows -p which does NOT start with -- so it's unquoted
    expect(result).toContain("-p");
  });

  it("handles empty array", () => {
    const result = shellQuoteArgs([]);
    expect(result).toBe("");
  });
});

// ── writeChannelConfig ────────────────────────────────────────────────────────

describe("writeChannelConfig", () => {
  it("writes .mcp.json to the workdir", () => {
    const workdir = getCtx().arkDir; // use temp dir as workdir
    const result = writeChannelConfig("s-abc123", "work", 19300, workdir);

    expect(result).toBe(join(workdir, ".mcp.json"));
    expect(existsSync(result)).toBe(true);
  });

  it("contains ark-channel key in mcpServers", () => {
    const workdir = getCtx().arkDir;
    writeChannelConfig("s-abc123", "work", 19300, workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers["ark-channel"]).toBeDefined();
  });

  it("includes correct env vars in channel config", () => {
    const workdir = getCtx().arkDir;
    writeChannelConfig("s-abc123", "work", 19300, workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    const channelConfig = content.mcpServers["ark-channel"];
    expect(channelConfig.env.ARK_SESSION_ID).toBe("s-abc123");
    expect(channelConfig.env.ARK_STAGE).toBe("work");
    expect(channelConfig.env.ARK_CHANNEL_PORT).toBe("19300");
  });

  it("includes ARK_CONDUCTOR_URL in channel config env", () => {
    const workdir = getCtx().arkDir;
    writeChannelConfig("s-abc123", "work", 19300, workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    const channelConfig = content.mcpServers["ark-channel"];
    expect(channelConfig.env.ARK_CONDUCTOR_URL).toBe("http://localhost:19100");
  });

  it("passes custom conductor URL to channelMcpConfig", () => {
    const config = channelMcpConfig("s-abc123", "work", 19300, {
      conductorUrl: "http://host.docker.internal:19100",
    });
    expect((config.env as Record<string, string>).ARK_CONDUCTOR_URL).toBe("http://host.docker.internal:19100");
  });

  it("channelMcpConfig defaults conductor URL to localhost:19100", () => {
    const config = channelMcpConfig("s-abc123", "work", 19300);
    expect((config.env as Record<string, string>).ARK_CONDUCTOR_URL).toBe("http://localhost:19100");
  });

  it("preserves existing .mcp.json content", () => {
    const workdir = getCtx().arkDir;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    writeFileSync(join(workdir, ".mcp.json"), JSON.stringify({
      mcpServers: { "other-server": { command: "other" } },
    }));

    writeChannelConfig("s-abc123", "work", 19300, workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["other-server"]).toBeDefined();
    expect(content.mcpServers["ark-channel"]).toBeDefined();
  });

  it("also writes mcp.json to tracks dir", () => {
    const workdir = getCtx().arkDir;
    writeChannelConfig("s-abc123", "work", 19300, workdir, { tracksDir: getApp().config.tracksDir });

    const tracksFile = join(getApp().config.tracksDir, "s-abc123", "mcp.json");
    expect(existsSync(tracksFile)).toBe(true);
    const content = JSON.parse(readFileSync(tracksFile, "utf-8"));
    expect(content.mcpServers["ark-channel"]).toBeDefined();
  });

  it("uses bun path from home directory in command", () => {
    const workdir = getCtx().arkDir;
    writeChannelConfig("s-test", "deploy", 19400, workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    const channelConfig = content.mcpServers["ark-channel"];
    expect(channelConfig.command).toContain(".bun/bin/bun");
  });

  it("merges MCP servers from original repo into worktree", () => {
    const workdir = getCtx().arkDir;
    const originalRepo = join(workdir, "original-repo");
    mkdirSync(originalRepo, { recursive: true });
    writeFileSync(join(originalRepo, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "context7": { command: "npx", args: ["-y", "@context7/mcp"] },
        "playwright": { command: "npx", args: ["-y", "@playwright/mcp"] },
      },
    }));

    const worktreeDir = join(workdir, "worktree");
    mkdirSync(worktreeDir, { recursive: true });

    writeChannelConfig("s-abc123", "work", 19300, worktreeDir, { originalRepoDir: originalRepo });

    const content = JSON.parse(readFileSync(join(worktreeDir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["ark-channel"]).toBeDefined();
    expect(content.mcpServers["context7"]).toEqual({ command: "npx", args: ["-y", "@context7/mcp"] });
    expect(content.mcpServers["playwright"]).toEqual({ command: "npx", args: ["-y", "@playwright/mcp"] });
  });

  it("does not override existing worktree MCP servers with original repo servers", () => {
    const workdir = getCtx().arkDir;
    const originalRepo = join(workdir, "original-repo");
    mkdirSync(originalRepo, { recursive: true });
    writeFileSync(join(originalRepo, ".mcp.json"), JSON.stringify({
      mcpServers: { "my-server": { command: "old-cmd" } },
    }));

    const worktreeDir = join(workdir, "worktree");
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(join(worktreeDir, ".mcp.json"), JSON.stringify({
      mcpServers: { "my-server": { command: "new-cmd" } },
    }));

    writeChannelConfig("s-abc123", "work", 19300, worktreeDir, { originalRepoDir: originalRepo });

    const content = JSON.parse(readFileSync(join(worktreeDir, ".mcp.json"), "utf-8"));
    // Worktree's existing server should NOT be overridden
    expect(content.mcpServers["my-server"]).toEqual({ command: "new-cmd" });
    expect(content.mcpServers["ark-channel"]).toBeDefined();
  });

  it("skips ark-channel from original repo MCP config", () => {
    const workdir = getCtx().arkDir;
    const originalRepo = join(workdir, "original-repo");
    mkdirSync(originalRepo, { recursive: true });
    writeFileSync(join(originalRepo, ".mcp.json"), JSON.stringify({
      mcpServers: {
        "ark-channel": { command: "stale-bun", env: { ARK_SESSION_ID: "s-old" } },
        "useful-server": { command: "useful" },
      },
    }));

    const worktreeDir = join(workdir, "worktree");
    mkdirSync(worktreeDir, { recursive: true });

    writeChannelConfig("s-new", "work", 19300, worktreeDir, { originalRepoDir: originalRepo });

    const content = JSON.parse(readFileSync(join(worktreeDir, ".mcp.json"), "utf-8"));
    // ark-channel should be the NEW one, not the stale one from original
    expect(content.mcpServers["ark-channel"].env.ARK_SESSION_ID).toBe("s-new");
    expect(content.mcpServers["useful-server"]).toEqual({ command: "useful" });
  });

  it("does not merge when originalRepoDir equals workdir", () => {
    const workdir = getCtx().arkDir;
    writeFileSync(join(workdir, ".mcp.json"), JSON.stringify({
      mcpServers: { "existing": { command: "existing" } },
    }));

    // When originalRepoDir === workdir, no merging happens (no worktree was created)
    writeChannelConfig("s-abc123", "work", 19300, workdir, { originalRepoDir: workdir });

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["existing"]).toBeDefined();
    expect(content.mcpServers["ark-channel"]).toBeDefined();
  });

  it("handles missing .mcp.json in original repo gracefully", () => {
    const workdir = getCtx().arkDir;
    const originalRepo = join(workdir, "no-mcp-repo");
    mkdirSync(originalRepo, { recursive: true });

    const worktreeDir = join(workdir, "worktree");
    mkdirSync(worktreeDir, { recursive: true });

    // Should not throw -- original repo has no .mcp.json
    writeChannelConfig("s-abc123", "work", 19300, worktreeDir, { originalRepoDir: originalRepo });

    const content = JSON.parse(readFileSync(join(worktreeDir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["ark-channel"]).toBeDefined();
  });
});

// ── removeChannelConfig ──────────────────────────────────────────────────────

describe("removeChannelConfig", () => {
  it("removes ark-channel from .mcp.json", () => {
    const workdir = getCtx().arkDir;
    writeChannelConfig("s-abc123", "work", 19300, workdir);
    expect(existsSync(join(workdir, ".mcp.json"))).toBe(true);

    removeChannelConfig(workdir);

    // File should be removed entirely (no other servers)
    expect(existsSync(join(workdir, ".mcp.json"))).toBe(false);
  });

  it("preserves other MCP servers in .mcp.json", () => {
    const workdir = getCtx().arkDir;
    writeFileSync(join(workdir, ".mcp.json"), JSON.stringify({
      mcpServers: { "other-server": { command: "other" } },
    }));

    writeChannelConfig("s-abc123", "work", 19300, workdir);
    removeChannelConfig(workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["other-server"]).toBeDefined();
    expect(content.mcpServers["ark-channel"]).toBeUndefined();
  });

  it("preserves non-mcpServers keys in .mcp.json", () => {
    const workdir = getCtx().arkDir;
    writeFileSync(join(workdir, ".mcp.json"), JSON.stringify({
      mcpServers: { "ark-channel": { command: "bun" } },
      customKey: "preserved",
    }));

    removeChannelConfig(workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    expect(content.customKey).toBe("preserved");
    expect(content.mcpServers).toBeUndefined();
  });

  it("does nothing if no .mcp.json exists", () => {
    expect(() => removeChannelConfig(getCtx().arkDir)).not.toThrow();
  });

  it("does nothing if .mcp.json has no ark-channel", () => {
    const workdir = getCtx().arkDir;
    writeFileSync(join(workdir, ".mcp.json"), JSON.stringify({
      mcpServers: { "other-server": { command: "other" } },
    }));

    removeChannelConfig(workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["other-server"]).toBeDefined();
  });

  it("is idempotent -- calling twice does not error", () => {
    const workdir = getCtx().arkDir;
    writeChannelConfig("s-abc123", "work", 19300, workdir);
    removeChannelConfig(workdir);
    expect(() => removeChannelConfig(workdir)).not.toThrow();
  });
});

// ── buildLauncher ─────────────────────────────────────────────────────────────

describe("buildLauncher", () => {
  const baseOpts: LauncherOpts = {
    workdir: "/tmp/project",
    claudeArgs: ["claude", "--model", "opus", "--dangerously-skip-permissions"],
    mcpConfigPath: "/tmp/.mcp.json",
  };

  it("returns content and claudeSessionId", () => {
    const result = buildLauncher(baseOpts);
    expect(result.content).toBeTruthy();
    expect(result.claudeSessionId).toBeTruthy();
  });

  it("starts with #!/bin/bash shebang", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content.startsWith("#!/bin/bash")).toBe(true);
  });

  it("includes cd to workdir", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content).toContain("cd '/tmp/project'");
  });

  it("includes --session-id with generated UUID when no claudeSessionId provided", () => {
    const { content, claudeSessionId } = buildLauncher(baseOpts);
    expect(content).toContain("--session-id");
    expect(content).toContain(claudeSessionId);
  });

  it("uses provided claudeSessionId", () => {
    const { content, claudeSessionId } = buildLauncher({
      ...baseOpts,
      claudeSessionId: "my-fixed-uuid",
    });
    expect(claudeSessionId).toBe("my-fixed-uuid");
    expect(content).toContain("my-fixed-uuid");
  });

  it("includes --resume with prevClaudeSessionId", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      prevClaudeSessionId: "old-session-uuid",
    });
    expect(content).toContain("--resume");
    expect(content).toContain("old-session-uuid");
  });

  it("includes fallback --session-id when prevClaudeSessionId is set", () => {
    const { content, claudeSessionId } = buildLauncher({
      ...baseOpts,
      prevClaudeSessionId: "old-session-uuid",
    });
    // Should have both --resume AND --session-id (fallback)
    expect(content).toContain("--resume");
    expect(content).toContain("--session-id");
    expect(content).toContain(claudeSessionId);
  });

  it("does not include --resume without prevClaudeSessionId", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content).not.toContain("--resume");
  });

  it("includes --remote-control with sessionName", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      sessionName: "my-task-session",
    });
    expect(content).toContain("--remote-control");
    expect(content).toContain("my-task-session");
  });

  it("defaults --remote-control to 'ark' without sessionName", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content).toContain("--remote-control");
    expect(content).toContain("'ark'");
  });

  it("includes --dangerously-load-development-channels server:ark-channel", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content).toContain("--dangerously-load-development-channels server:ark-channel");
  });

  it("ends with exec bash", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content.trimEnd().endsWith("exec bash")).toBe(true);
  });

  it("shell-quotes the claude args in the launcher", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      claudeArgs: ["claude", "--model", "claude-opus-4-6"],
    });
    expect(content).toContain("--model");
    expect(content).toContain("'claude-opus-4-6'");
  });

  it("includes env var exports when env provided", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "80", MY_VAR: "hello world" },
    });
    expect(content).toContain("export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='80'");
    expect(content).toContain("export MY_VAR='hello world'");
  });

  it("does not include custom env when env is empty", () => {
    const { content } = buildLauncher({ ...baseOpts, env: {} });
    // PATH export is always present; custom env vars should not be
    const lines = content.split("\n").filter(l => l.startsWith("export ") && !l.includes("PATH="));
    expect(lines.length).toBe(0);
  });

  it("does not include custom env when env is undefined", () => {
    const { content } = buildLauncher(baseOpts);
    const lines = content.split("\n").filter(l => l.startsWith("export ") && !l.includes("PATH="));
    expect(lines.length).toBe(0);
  });

  it("env vars appear after cd and before claude command", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      env: { FOO: "bar" },
    });
    const cdIndex = content.indexOf("cd ");
    const exportIndex = content.indexOf("export FOO=");
    const claudeIndex = content.indexOf("claude");
    expect(exportIndex).toBeGreaterThan(cdIndex);
    expect(claudeIndex).toBeGreaterThan(exportIndex);
  });
});

// ── buildLauncher initialPrompt ──────────────────────────────────────────────

describe("buildLauncher initialPrompt", () => {
  const baseOpts: LauncherOpts = {
    workdir: "/tmp/project",
    claudeArgs: ["claude", "--model", "opus", "--dangerously-skip-permissions"],
    mcpConfigPath: "/tmp/.mcp.json",
  };

  it("appends shell-quoted prompt as last positional arg", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      initialPrompt: "Fix the login bug",
    });
    expect(content).toContain("'Fix the login bug'");
    // Should appear after the extra flags
    const flagsIndex = content.indexOf("--remote-control");
    const promptIndex = content.indexOf("'Fix the login bug'");
    expect(promptIndex).toBeGreaterThan(flagsIndex);
  });

  it("escapes single quotes in prompt", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      initialPrompt: "don't break it",
    });
    // POSIX escaping: 'don'\''t break it'
    expect(content).toContain("don'\\''t break it");
  });

  it("does not include prompt arg when initialPrompt is undefined", () => {
    const { content } = buildLauncher(baseOpts);
    // After the --remote-control line, script should just have exec bash
    const lines = content.split("\n");
    const execLine = lines.findIndex(l => l.trim() === "exec bash");
    // The line before exec bash should not contain a quoted prompt
    expect(lines[execLine - 1]).not.toMatch(/^\s+'.*'$/);
  });

  it("includes prompt in resume fallback branch too", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      prevClaudeSessionId: "old-uuid",
      initialPrompt: "Continue the task",
    });
    // Both the --resume branch and --session-id fallback should have the prompt
    const matches = content.match(/'Continue the task'/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });
});

// ── trustDirectory ────────────────────────────────────────────────────────────

describe("trustDirectory", () => {
  it("is exported as a function", () => {
    expect(typeof trustDirectory).toBe("function");
  });
});
