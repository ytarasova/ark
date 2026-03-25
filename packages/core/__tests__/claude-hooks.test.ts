/**
 * Tests for claude.ts hook config — writeHooksConfig / removeHooksConfig.
 */
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  createTestContext, setContext, resetContext,
  type TestContext,
} from "../context.js";
import { writeHooksConfig, removeHooksConfig } from "../claude.js";

let ctx: TestContext;

beforeEach(() => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
});

afterAll(() => {
  if (ctx) ctx.cleanup();
  resetContext();
});

describe("writeHooksConfig", () => {
  it("creates .claude/settings.local.json in workdir", () => {
    writeHooksConfig("s-test123", "http://localhost:19100", ctx.arkDir);
    expect(existsSync(join(ctx.arkDir, ".claude", "settings.local.json"))).toBe(true);
  });

  it("contains hooks for all 8 events", () => {
    writeHooksConfig("s-test123", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    const events = Object.keys(settings.hooks);
    expect(events).toContain("SessionStart");
    expect(events).toContain("UserPromptSubmit");
    expect(events).toContain("Stop");
    expect(events).toContain("StopFailure");
    expect(events).toContain("SessionEnd");
    expect(events).toContain("Notification");
    expect(events).toContain("PreCompact");
    expect(events).toContain("PostCompact");
    expect(events.length).toBe(8);
  });

  it("PreCompact/PostCompact hooks have no matcher (match all triggers)", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.PreCompact[0].matcher).toBeUndefined();
    expect(settings.hooks.PostCompact[0].matcher).toBeUndefined();
  });

  it("hooks use command type with curl to correct conductor URL", () => {
    writeHooksConfig("s-abc", "http://host.docker.internal:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("curl");
    expect(cmd).toContain("host.docker.internal:19100");
    expect(cmd).toContain("s-abc");
  });

  it("all hooks are async", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    for (const matchers of Object.values(settings.hooks) as any[][]) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          expect(hook.async).toBe(true);
        }
      }
    }
  });

  it("preserves existing non-hook settings", () => {
    const claudeDir = join(ctx.arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));

    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.hooks).toBeDefined();
  });

  it("is idempotent — calling twice doesn't duplicate hooks", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Stop.length).toBe(1);
  });

  it("includes session ID in hook command", () => {
    writeHooksConfig("s-myid", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("s-myid");
  });

  it("hook command is a single line (no newlines)", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).not.toContain("\n");
    expect(cmd.split("\n").length).toBe(1);
  });

  it("hook command suppresses curl output", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("> /dev/null 2>&1");
  });

  it("SessionStart has startup|resume matcher", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.SessionStart[0].matcher).toBe("startup|resume");
  });

  it("Notification has permission_prompt|idle_prompt matcher", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    const settings = JSON.parse(readFileSync(join(ctx.arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Notification[0].matcher).toBe("permission_prompt|idle_prompt");
  });
});

describe("removeHooksConfig", () => {
  it("removes ark hooks but preserves other settings", () => {
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);
    // Add extra settings
    const settingsPath = join(ctx.arkDir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.permissions = { allow: ["Bash"] };
    writeFileSync(settingsPath, JSON.stringify(settings));

    removeHooksConfig(ctx.arkDir);
    const cleaned = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(cleaned.permissions.allow).toContain("Bash");
    expect(cleaned.hooks).toBeUndefined();
  });

  it("does nothing if no settings file exists", () => {
    expect(() => removeHooksConfig(ctx.arkDir)).not.toThrow();
  });

  it("preserves non-ark hooks", () => {
    const claudeDir = join(ctx.arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "my-custom-hook.sh", async: true }] }],
      }
    }));

    // Add ark hooks on top
    writeHooksConfig("s-test", "http://localhost:19100", ctx.arkDir);

    // Remove ark hooks
    removeHooksConfig(ctx.arkDir);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.Stop.length).toBe(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("my-custom-hook.sh");
  });
});
