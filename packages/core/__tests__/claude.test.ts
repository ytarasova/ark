/**
 * Tests for claude.ts -- model mapping, argument building, shell quoting,
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
  buildChannelConfig,
  buildSettings,
  trustDirectory,
  type ClaudeArgsOpts,
  type LauncherOpts,
} from "../claude/claude.js";
import { DEFAULT_CONDUCTOR_PORT } from "../constants.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

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
    expect(channelConfig.env.ARK_CONDUCTOR_URL).toBe(`http://localhost:${DEFAULT_CONDUCTOR_PORT}`);
  });

  it("passes custom conductor URL to channelMcpConfig", () => {
    const config = channelMcpConfig("s-abc123", "work", 19300, {
      conductorUrl: "http://host.docker.internal:19100",
    });
    expect((config.env as Record<string, string>).ARK_CONDUCTOR_URL).toBe("http://host.docker.internal:19100");
  });

  it("channelMcpConfig defaults conductor URL to the merged conductor port on localhost", () => {
    const config = channelMcpConfig("s-abc123", "work", 19300);
    expect((config.env as Record<string, string>).ARK_CONDUCTOR_URL).toBe(`http://localhost:${DEFAULT_CONDUCTOR_PORT}`);
  });

  it("preserves existing .mcp.json content", () => {
    const workdir = getCtx().arkDir;
    writeFileSync(
      join(workdir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "other-server": { command: "other" } },
      }),
    );

    writeChannelConfig("s-abc123", "work", 19300, workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["other-server"]).toBeDefined();
    expect(content.mcpServers["ark-channel"]).toBeDefined();
  });

  it("also writes mcp.json to tracks dir", () => {
    const workdir = getCtx().arkDir;
    writeChannelConfig("s-abc123", "work", 19300, workdir, { tracksDir: getApp().config.dirs.tracks });

    const tracksFile = join(getApp().config.dirs.tracks, "s-abc123", "mcp.json");
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
    writeFileSync(
      join(originalRepo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          context7: { command: "npx", args: ["-y", "@context7/mcp"] },
          playwright: { command: "npx", args: ["-y", "@playwright/mcp"] },
        },
      }),
    );

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
    writeFileSync(
      join(originalRepo, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "my-server": { command: "old-cmd" } },
      }),
    );

    const worktreeDir = join(workdir, "worktree");
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      join(worktreeDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "my-server": { command: "new-cmd" } },
      }),
    );

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
    writeFileSync(
      join(originalRepo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "ark-channel": { command: "stale-bun", env: { ARK_SESSION_ID: "s-old" } },
          "useful-server": { command: "useful" },
        },
      }),
    );

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
    writeFileSync(
      join(workdir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { existing: { command: "existing" } },
      }),
    );

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
    writeFileSync(
      join(workdir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "other-server": { command: "other" } },
      }),
    );

    writeChannelConfig("s-abc123", "work", 19300, workdir);
    removeChannelConfig(workdir);

    const content = JSON.parse(readFileSync(join(workdir, ".mcp.json"), "utf-8"));
    expect(content.mcpServers["other-server"]).toBeDefined();
    expect(content.mcpServers["ark-channel"]).toBeUndefined();
  });

  it("preserves non-mcpServers keys in .mcp.json", () => {
    const workdir = getCtx().arkDir;
    writeFileSync(
      join(workdir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "ark-channel": { command: "bun" } },
        customKey: "preserved",
      }),
    );

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
    writeFileSync(
      join(workdir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { "other-server": { command: "other" } },
      }),
    );

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

  it("does not include --remote-control (dropped -- polluted host workspace)", () => {
    const { content } = buildLauncher({ ...baseOpts, sessionName: "my-task-session" });
    expect(content).not.toContain("--remote-control");
  });

  it("includes --dangerously-load-development-channels=server:ark-channel", () => {
    // Claude Code 2.1.x rejects `.mcp.json` channel entries with the warning
    // `entries need --dangerously-load-development-channels` unless this
    // flag is set. The `=value` form (rather than a separate positional)
    // keeps the flag from greedily consuming the appended prompt.
    const { content } = buildLauncher(baseOpts);
    expect(content).toContain("--dangerously-load-development-channels=server:ark-channel");
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
    const lines = content.split("\n").filter((l) => l.startsWith("export ") && !l.includes("PATH="));
    expect(lines.length).toBe(0);
  });

  it("does not include custom env when env is undefined", () => {
    const { content } = buildLauncher(baseOpts);
    const lines = content.split("\n").filter((l) => l.startsWith("export ") && !l.includes("PATH="));
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
    // Should appear after the channel flag.
    const flagsIndex = content.indexOf("--dangerously-load-development-channels=");
    const promptIndex = content.indexOf("'Fix the login bug'");
    expect(promptIndex).toBeGreaterThan(flagsIndex);
  });

  it("inserts `--` between the channel flag and the prompt positional (bug 2)", () => {
    // `--dangerously-load-development-channels` is greedy and would eat
    // the prompt as another channel entry. The `=value` form scopes the
    // value tightly, and the `--` separator is belt-and-braces.
    const { content } = buildLauncher({
      ...baseOpts,
      initialPrompt: "Fix the login bug",
    });
    const channelFlagIdx = content.indexOf("--dangerously-load-development-channels=");
    const separatorIdx = content.indexOf(" -- ", channelFlagIdx + "--dangerously-load-development-channels=".length);
    const promptIdx = content.indexOf("'Fix the login bug'");
    expect(separatorIdx).toBeGreaterThan(channelFlagIdx);
    expect(promptIdx).toBeGreaterThan(separatorIdx);
  });

  it("includes the `--` separator in both resume and fallback branches", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      prevClaudeSessionId: "old-uuid",
      initialPrompt: "Continue the task",
    });
    // Two prompt positionals (resume + fallback) should each be preceded by `--`.
    const matches = content.match(/--\s+'Continue the task'/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });

  it("does not add a `--` separator when there is no prompt", () => {
    const { content } = buildLauncher(baseOpts);
    // With no initialPrompt there is no positional to separate, so the
    // launcher should not contain a dangling `--` on the claude line.
    const channelLineIdx = content.indexOf("--dangerously-load-development-channels=");
    const afterChannel = content.slice(channelLineIdx);
    // The line ends after the dangerously-load flag value; nothing more.
    const trailingDashes = afterChannel.match(/^[^\n]*\n\s*--/);
    expect(trailingDashes).toBeNull();
  });
});

// ── buildLauncher exit-code sentinel (bug 3) ─────────────────────────────────

describe("buildLauncher exit-code sentinel", () => {
  const baseOpts: LauncherOpts = {
    workdir: "/tmp/project",
    claudeArgs: ["claude", "--model", "opus", "--dangerously-skip-permissions"],
    mcpConfigPath: "/tmp/.mcp.json",
  };

  it("wraps the claude invocation in an if/else that writes exit-code on failure", () => {
    const { content } = buildLauncher(baseOpts);
    // The claude command should be the `if` condition.
    expect(content).toMatch(/if claude --/);
    // The else branch captures $? and writes it to exit-code.
    expect(content).toContain("code=$?");
    expect(content).toContain('echo "$code" > "${ARK_SESSION_DIR:-/tmp/ark-session-unknown}"/exit-code');
  });

  it("references $ARK_SESSION_DIR so the sentinel lands where the poller looks", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content).toContain("${ARK_SESSION_DIR:-/tmp/ark-session-unknown}");
  });

  it("keeps exec bash at the end so tmux stays alive for post-mortem", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content.trimEnd().endsWith("exec bash")).toBe(true);
  });

  it("resume + fallback: only the final failure writes the sentinel", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      prevClaudeSessionId: "old-uuid",
    });
    // There should be exactly one exit-code write (after both primary and
    // fallback fail), not two.
    const sentinelWrites = content.match(/echo\s+"\$code"\s+>\s+/g);
    expect(sentinelWrites).not.toBeNull();
    expect(sentinelWrites!.length).toBe(1);
    // Both the primary (--resume) and the fallback (--session-id) should appear.
    expect(content).toContain("--resume");
    expect(content).toContain("--session-id");
  });

  it("prints a human-readable failure message to stderr", () => {
    const { content } = buildLauncher(baseOpts);
    expect(content).toMatch(/Claude exited with code \$code\. Session marked failed\./);
    expect(content).toContain(">&2");
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
    // After the channel flag, script should just have exec bash
    const lines = content.split("\n");
    const execLine = lines.findIndex((l) => l.trim() === "exec bash");
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

// ── buildLauncher PTY geometry ──────────────────────────────────────────────

describe("buildLauncher PTY geometry", () => {
  const baseOpts: LauncherOpts = {
    workdir: "/tmp/project",
    claudeArgs: ["claude", "--model", "opus", "--dangerously-skip-permissions"],
    mcpConfigPath: "/tmp/.mcp.json",
  };

  it("does not export COLUMNS / LINES or wait on a geometry sentinel", () => {
    // Geometry is deferred to the first WebSocket resize, which calls
    // `tmux resize-window` and SIGWINCHes the running claude. The launcher
    // must not set COLUMNS / LINES (that would pin the PTY before reflow)
    // and must not gate the launch on a sentinel file.
    const { content } = buildLauncher(baseOpts);
    expect(content).not.toContain("export COLUMNS");
    expect(content).not.toContain("export LINES");
    expect(content).not.toMatch(/GEOMETRY_SENTINEL/);
    expect(content).not.toMatch(/GEOMETRY_WAIT_MS/);
  });
});

// ── buildLauncher embedFiles (heredoc emission for remote dispatch) ──────────

describe("buildLauncher embedFiles", () => {
  const baseOpts: LauncherOpts = {
    workdir: "/home/ubuntu/Projects/ark",
    claudeArgs: ["claude", "--model", "opus"],
    mcpConfigPath: "/home/ubuntu/Projects/ark/.mcp.json",
  };

  it("emits no heredoc block when embedFiles is empty/undefined", () => {
    const { content: a } = buildLauncher(baseOpts);
    const { content: b } = buildLauncher({ ...baseOpts, embedFiles: [] });
    expect(a).not.toContain("ARK_EOF_");
    expect(b).not.toContain("ARK_EOF_");
  });

  it("writes each embedded file via a quoted heredoc with mkdir -p on the parent", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      embedFiles: [
        { relPath: ".mcp.json", content: '{"mcpServers":{}}' },
        { relPath: ".claude/settings.local.json", content: '{"hooks":{}}' },
      ],
    });
    expect(content).toContain(`cat > '/home/ubuntu/Projects/ark/.mcp.json' <<'ARK_EOF_0'`);
    expect(content).toContain('{"mcpServers":{}}');
    expect(content).toContain(`cat > '/home/ubuntu/Projects/ark/.claude/settings.local.json' <<'ARK_EOF_1'`);
    expect(content).toContain('{"hooks":{}}');
    // Each heredoc terminator on its own line
    expect(content).toMatch(/\nARK_EOF_0\n/);
    expect(content).toMatch(/\nARK_EOF_1\n/);
    // mkdir -p the parent of each target
    expect(content).toContain(`mkdir -p "$(dirname '/home/ubuntu/Projects/ark/.mcp.json')"`);
    expect(content).toContain(`mkdir -p "$(dirname '/home/ubuntu/Projects/ark/.claude/settings.local.json')"`);
  });

  it("uses a quoted heredoc tag so $-interpolation in JSON content is preserved", () => {
    // A literal $VAR in the file content must not be expanded by bash before
    // hitting disk -- the tag wrapping single quotes (`'ARK_EOF_0'`) suppresses
    // interpolation. This guards against future maintainers swapping in an
    // unquoted tag.
    const tricky = '{"key":"value with $HOME and ${PATH} and `cmd`"}';
    const { content } = buildLauncher({
      ...baseOpts,
      embedFiles: [{ relPath: ".mcp.json", content: tricky }],
    });
    expect(content).toContain("<<'ARK_EOF_0'");
    expect(content).toContain(tricky);
  });

  it("treats absolute relPath as-is without prepending workdir", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      embedFiles: [{ relPath: "/etc/something/config", content: "x" }],
    });
    expect(content).toContain(`cat > '/etc/something/config' <<'ARK_EOF_0'`);
    expect(content).not.toContain("/home/ubuntu/Projects/ark/etc/something");
  });

  it("emits heredocs after `cd` so writes land in the workdir Claude runs in", () => {
    const { content } = buildLauncher({
      ...baseOpts,
      embedFiles: [{ relPath: ".mcp.json", content: "{}" }],
    });
    const cdIdx = content.indexOf("cd '/home/ubuntu/Projects/ark'");
    const heredocIdx = content.indexOf("cat > '/home/ubuntu/Projects/ark/.mcp.json'");
    expect(cdIdx).toBeGreaterThan(-1);
    expect(heredocIdx).toBeGreaterThan(cdIdx);
  });
});

// ── buildSettings (pure builder for .claude/settings.local.json) ────────────

describe("buildSettings", () => {
  it("returns a JSON object with hooks for every ark-tracked event", () => {
    const { object, content, hookCount } = buildSettings("s-test", "http://127.0.0.1:19100");
    expect(typeof object).toBe("object");
    expect(content).toBe(JSON.stringify(object, null, 2));
    // Every ark hook event group must be present.
    const hooks = (object as { hooks: Record<string, unknown[]> }).hooks;
    for (const ev of [
      "PreToolUse",
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "SessionEnd",
      "Notification",
      "PreCompact",
      "PostCompact",
    ]) {
      expect(hooks[ev]).toBeTruthy();
    }
    expect(hookCount).toBe(Object.keys(hooks).length);
  });

  it("each ark-injected matcher group carries _ark: true so teardown can find it", () => {
    const { object } = buildSettings("s-test", "http://127.0.0.1:19100");
    const hooks = (object as { hooks: Record<string, Array<{ _ark?: boolean }>> }).hooks;
    for (const matchers of Object.values(hooks)) {
      expect(matchers[0]?._ark).toBe(true);
    }
  });

  it("bakes the arkd channel-publish URL into the curl command", () => {
    // The launcher hook now POSTs to local arkd's `/channel/hooks/publish`,
    // not the conductor's `/hooks/status`. Arkd buffers the envelope on the
    // `hooks` channel and the conductor subscribes via
    // `/channel/hooks/subscribe`.
    const { content } = buildSettings("s-abc", "http://localhost:19300");
    expect(content).toContain("http://localhost:19300/channel/hooks/publish");
    // Session id is embedded in the envelope (and in the wrapper's args).
    expect(content).toContain("s-abc");
  });

  it("merges with an existing settings object instead of clobbering", () => {
    const existing = { extra: "preserved", hooks: { Custom: [{ command: "echo hi" }] } };
    const { object } = buildSettings("s-test", "http://x", { existing });
    expect((object as { extra: string }).extra).toBe("preserved");
    // User's Custom hook is preserved (not _ark, not curl-marker).
    expect((object as { hooks: Record<string, unknown[]> }).hooks.Custom).toBeTruthy();
  });

  it("sets _ark.sessionId and _ark.arkdUrl in the metadata", () => {
    const { object } = buildSettings("s-meta", "http://c");
    const meta = (object as { _ark: { sessionId: string; arkdUrl: string; updatedAt: string } })._ark;
    expect(meta.sessionId).toBe("s-meta");
    expect(meta.arkdUrl).toBe("http://c");
    expect(meta.updatedAt).toBeTruthy();
  });

  it("autonomy=read-only emits a deny list of Bash, Write, Edit", () => {
    const { object } = buildSettings("s", "u", { autonomy: "read-only" });
    const perms = (object as { permissions?: { deny?: string[] } }).permissions;
    expect(perms?.deny).toEqual(["Bash", "Write", "Edit"]);
  });
});

// ── buildChannelConfig (pure builder for .mcp.json) ──────────────────────────

describe("buildChannelConfig", () => {
  it("includes the ark-channel server with the right session/stage/port env", () => {
    const { object } = buildChannelConfig("s-abc", "work", 19345);
    const channel = (object as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers[
      "ark-channel"
    ];
    expect(channel).toBeTruthy();
    expect(channel.env.ARK_SESSION_ID).toBe("s-abc");
    expect(channel.env.ARK_STAGE).toBe("work");
    expect(channel.env.ARK_CHANNEL_PORT).toBe("19345");
  });

  it("ark-channel always wins over a same-named entry in opts.existing", () => {
    const existing = { mcpServers: { "ark-channel": { command: "stale" } } };
    const { object } = buildChannelConfig("s", "work", 1, { existing });
    const channel = (object as { mcpServers: Record<string, { command?: string }> }).mcpServers["ark-channel"];
    expect(channel.command).not.toBe("stale");
  });

  it("preserves user-declared MCP servers from opts.existing without overriding", () => {
    const existing = { mcpServers: { "user-mcp": { command: "user-cmd", args: [] } } };
    const { object } = buildChannelConfig("s", "work", 1, { existing });
    const userMcp = (object as { mcpServers: Record<string, { command: string }> }).mcpServers["user-mcp"];
    expect(userMcp.command).toBe("user-cmd");
  });

  it("includeLocalCodebaseMemory:false skips the conductor-side binary probe", () => {
    // The default path runs `findCodebaseMemoryBinary()` + `existsSync`. With
    // the flag off, the builder must NOT attempt to inject a `codebase-memory`
    // entry even if the conductor happens to have one installed.
    const { object: off } = buildChannelConfig("s", "work", 1, { includeLocalCodebaseMemory: false });
    expect((off as { mcpServers: Record<string, unknown> }).mcpServers["codebase-memory"]).toBeUndefined();
  });

  it("uses the provided channelConfig instead of channelMcpConfig() when supplied", () => {
    const customChannel = { command: "/custom/ark", args: ["channel"], env: { CUSTOM: "1" } };
    const { object } = buildChannelConfig("s", "work", 1, { channelConfig: customChannel });
    const channel = (object as { mcpServers: Record<string, { command: string }> }).mcpServers["ark-channel"];
    expect(channel.command).toBe("/custom/ark");
  });

  it("content is a stable JSON string of the object (2-space indent)", () => {
    const { object, content } = buildChannelConfig("s", "work", 1);
    expect(content).toBe(JSON.stringify(object, null, 2));
  });
});

// ── trustDirectory ────────────────────────────────────────────────────────────

describe("trustDirectory", () => {
  it("is exported as a function", () => {
    expect(typeof trustDirectory).toBe("function");
  });
});
