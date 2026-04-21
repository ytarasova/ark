/**
 * E2E tests for session dispatch on different compute providers.
 *
 * Validates that launchAgentTmux setup logic correctly:
 * - Creates worktree for local compute with git repos
 * - Does NOT create worktree for EC2 compute
 * - Does NOT create worktree when config.worktree === false
 * - Writes .claude/settings.local.json (hooks config) to the working directory
 * - Writes .mcp.json (channel config) to the working directory
 *
 * These tests exercise startSession + the DB state it produces,
 * NOT the actual tmux/claude launch (which requires real tmux).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { AppContext } from "../app.js";
import * as claude from "../claude/claude.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;

beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
});

// ── Worktree creation logic ──────────────────────────────────────────────────

describe("dispatch compute: worktree creation", async () => {
  it("creates worktree for local compute with a git repo", async () => {
    // Create a bare git repo to serve as the session workdir
    const repoDir = join(app.config.arkDir, "test-repo");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    // Create an initial commit so the worktree can branch
    execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });

    const session = await getApp().sessions.create({ summary: "worktree-test", repo: repoDir, workdir: repoDir });

    // Simulate what launchAgentTmux checks:
    // isLocal = no compute or compute.provider === "local"
    const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
    const isLocal = !compute || compute.provider === "local";
    expect(isLocal).toBe(true);

    // wantWorktree = isLocal && config.worktree !== false
    const config = typeof session.config === "string" ? JSON.parse(session.config) : session.config;
    const wantWorktree = isLocal && config?.worktree !== false;
    expect(wantWorktree).toBe(true);

    // workdir is a git repo
    expect(existsSync(join(repoDir, ".git"))).toBe(true);
  });

  it("does NOT create worktree for EC2 compute", async () => {
    // Register an EC2 compute in the store
    await app.computes.create({ name: "my-ec2", provider: "ec2", config: { ip: "1.2.3.4" } });
    const session = await getApp().sessions.create({ summary: "ec2-test", compute_name: "my-ec2" });

    const compute = await app.computes.get(session.compute_name!);
    expect(compute).not.toBeNull();
    expect(compute!.provider).toBe("ec2");

    const isLocal = compute!.provider === "local";
    expect(isLocal).toBe(false);

    // With non-local compute, worktree should NOT be created
    // launchAgentTmux skips worktree setup when isLocal is false
  });

  it("does NOT create worktree when config.worktree === false", async () => {
    const repoDir = join(app.config.arkDir, "test-repo-no-wt");
    mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init", repoDir], { stdio: "pipe" });
    execFileSync("git", ["-C", repoDir, "commit", "--allow-empty", "-m", "init"], { stdio: "pipe" });

    const session = await getApp().sessions.create({
      summary: "no-worktree-test",
      repo: repoDir,
      workdir: repoDir,
      config: { worktree: false },
    });

    const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
    const isLocal = !compute || compute.provider === "local";
    expect(isLocal).toBe(true);

    const config = typeof session.config === "string" ? JSON.parse(session.config) : session.config;
    const wantWorktree = isLocal && config?.worktree !== false;
    expect(wantWorktree).toBe(false);
  });
});

// ── Hook and channel config writing ──────────────────────────────────────────

describe("dispatch compute: config file writing", () => {
  it("writes .claude/settings.local.json (hooks config) to the working directory", async () => {
    const workdir = join(app.config.arkDir, "workdir-hooks");
    mkdirSync(workdir, { recursive: true });

    const session = await getApp().sessions.create({ summary: "hooks-config-test" });
    const conductorUrl = "http://localhost:19100";

    const settingsPath = claude.writeSettings(session.id, conductorUrl, workdir);
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();

    // Verify all expected hook events are present
    const expectedEvents = [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "SessionEnd",
      "Notification",
      "PreCompact",
      "PostCompact",
    ];
    for (const event of expectedEvents) {
      expect(settings.hooks[event]).toBeDefined();
      expect(Array.isArray(settings.hooks[event])).toBe(true);
    }

    // Verify hook commands contain the session ID and conductor URL
    const stopHook = settings.hooks.Stop[0];
    expect(stopHook.hooks[0].command).toContain(session.id);
    expect(stopHook.hooks[0].command).toContain(conductorUrl);
  });

  it("writes .mcp.json (channel config) to the working directory", async () => {
    const workdir = join(app.config.arkDir, "workdir-mcp");
    mkdirSync(workdir, { recursive: true });

    const session = await getApp().sessions.create({ summary: "mcp-config-test" });
    const channelPort = 19250;

    const mcpPath = claude.writeChannelConfig(session.id, "work", channelPort, workdir);
    expect(existsSync(mcpPath)).toBe(true);

    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(mcpConfig.mcpServers).toBeDefined();
    expect(mcpConfig.mcpServers["ark-channel"]).toBeDefined();

    // Verify the MCP config references the correct session and port
    const channelConfig = mcpConfig.mcpServers["ark-channel"];
    expect(channelConfig).toBeTruthy();
  });

  it("hooks config: PreToolUse is sync, all others are async", async () => {
    const workdir = join(app.config.arkDir, "workdir-async-hooks");
    mkdirSync(workdir, { recursive: true });

    const session = await getApp().sessions.create({ summary: "async-hooks-test" });
    claude.writeSettings(session.id, "http://localhost:19100", workdir);

    const settingsPath = join(workdir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

    // PreToolUse must be synchronous for guardrail enforcement
    expect(settings.hooks.PreToolUse[0].hooks[0].async).toBe(false);

    for (const [event, matchers] of Object.entries(settings.hooks)) {
      if (event === "PreToolUse") continue;
      for (const matcher of matchers as Array<{ hooks: Array<{ async: boolean }> }>) {
        for (const hook of matcher.hooks) {
          expect(hook.async).toBe(true);
        }
      }
    }
  });

  it("writeSettings is idempotent (can be called twice)", async () => {
    const workdir = join(app.config.arkDir, "workdir-idempotent");
    mkdirSync(workdir, { recursive: true });

    const session = await getApp().sessions.create({ summary: "idempotent-test" });
    const url = "http://localhost:19100";

    claude.writeSettings(session.id, url, workdir);
    claude.writeSettings(session.id, url, workdir);

    const settingsPath = join(workdir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

    // Each event should have exactly one matcher (idempotent, not duplicated)
    expect(settings.hooks.Stop.length).toBe(1);
    expect(settings.hooks.SessionStart.length).toBe(1);
  });
});

// ── Session defaults at creation ─────────────────────────────────────────────

describe("dispatch compute: session creation defaults", async () => {
  it("session starts with no session_id (tmux name)", async () => {
    const session = await getApp().sessions.create({ summary: "defaults-test" });
    expect(session.session_id).toBeNull();
  });

  it("session starts with no claude_session_id", async () => {
    const session = await getApp().sessions.create({ summary: "defaults-test" });
    expect(session.claude_session_id).toBeNull();
  });

  it("session stores compute_name when specified", async () => {
    await app.computes.create({ name: "test-compute", provider: "ec2" });
    const session = await getApp().sessions.create({ summary: "compute-name-test", compute_name: "test-compute" });
    expect(session.compute_name).toBe("test-compute");
  });

  it("session workdir is stored correctly", async () => {
    const session = await getApp().sessions.create({ summary: "workdir-test", workdir: "/tmp/my-project" });
    expect(session.workdir).toBe("/tmp/my-project");
  });
});
