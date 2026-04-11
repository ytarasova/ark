/**
 * Tests for claude.ts hook config — writeHooksConfig / removeHooksConfig.
 */
import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { writeHooksConfig, removeHooksConfig, buildPermissionsAllow } from "../claude/claude.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();

describe("writeHooksConfig", () => {
  it("creates .claude/settings.local.json in workdir", () => {
    writeHooksConfig("s-test123", "http://localhost:19100", getCtx().arkDir);
    expect(existsSync(join(getCtx().arkDir, ".claude", "settings.local.json"))).toBe(true);
  });

  it("contains hooks for all 9 events", () => {
    writeHooksConfig("s-test123", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const events = Object.keys(settings.hooks);
    expect(events).toContain("PreToolUse");
    expect(events).toContain("SessionStart");
    expect(events).toContain("UserPromptSubmit");
    expect(events).toContain("Stop");
    expect(events).toContain("StopFailure");
    expect(events).toContain("SessionEnd");
    expect(events).toContain("Notification");
    expect(events).toContain("PreCompact");
    expect(events).toContain("PostCompact");
    expect(events.length).toBe(9);
  });

  it("PreCompact/PostCompact hooks have no matcher (match all triggers)", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.PreCompact[0].matcher).toBeUndefined();
    expect(settings.hooks.PostCompact[0].matcher).toBeUndefined();
  });

  it("hooks use command type with curl to correct conductor URL", () => {
    writeHooksConfig("s-abc", "http://host.docker.internal:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("curl");
    expect(cmd).toContain("host.docker.internal:19100");
    expect(cmd).toContain("s-abc");
  });

  it("PreToolUse hook is sync, all others are async", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    // PreToolUse must be synchronous for guardrail enforcement
    expect(settings.hooks.PreToolUse[0].hooks[0].async).toBe(false);
    // All other hooks should be async
    for (const [event, matchers] of Object.entries(settings.hooks) as [string, any[]][]) {
      if (event === "PreToolUse") continue;
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          expect(hook.async).toBe(true);
        }
      }
    }
  });

  it("preserves existing non-hook settings", () => {
    const claudeDir = join(getCtx().arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));

    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.hooks).toBeDefined();
  });

  it("is idempotent — calling twice doesn't duplicate hooks", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Stop.length).toBe(1);
  });

  it("includes session ID in hook command", () => {
    writeHooksConfig("s-myid", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("s-myid");
  });

  it("hook command is a single line (no newlines)", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).not.toContain("\n");
    expect(cmd.split("\n").length).toBe(1);
  });

  it("hook command suppresses curl output", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("> /dev/null 2>&1");
  });

  it("SessionStart has startup|resume matcher", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.SessionStart[0].matcher).toBe("startup|resume");
  });

  it("Notification has permission_prompt|idle_prompt matcher", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Notification[0].matcher).toBe("permission_prompt|idle_prompt");
  });
});

describe("removeHooksConfig", () => {
  it("removes ark hooks but preserves other settings", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    // Add extra settings
    const settingsPath = join(getCtx().arkDir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.permissions = { allow: ["Bash"] };
    writeFileSync(settingsPath, JSON.stringify(settings));

    removeHooksConfig(getCtx().arkDir);
    const cleaned = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(cleaned.permissions.allow).toContain("Bash");
    expect(cleaned.hooks).toBeUndefined();
  });

  it("does nothing if no settings file exists", () => {
    expect(() => removeHooksConfig(getCtx().arkDir)).not.toThrow();
  });

  it("preserves non-ark hooks", () => {
    const claudeDir = join(getCtx().arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "my-custom-hook.sh", async: true }] }],
      }
    }));

    // Add ark hooks on top
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);

    // Remove ark hooks
    removeHooksConfig(getCtx().arkDir);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings.hooks.Stop).toBeDefined();
    expect(settings.hooks.Stop.length).toBe(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("my-custom-hook.sh");
  });
});

// ── buildPermissionsAllow unit tests ────────────────────────────────────────

describe("buildPermissionsAllow", () => {
  it("passes built-in tool names through unchanged", () => {
    const allow = buildPermissionsAllow({ tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] });
    expect(allow).toEqual(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]);
  });

  it("auto-adds wildcard for each declared MCP server when tools has no explicit entry", () => {
    const allow = buildPermissionsAllow({
      tools: ["Bash", "Read"],
      mcp_servers: ["atlassian", "figma"],
    });
    expect(allow).toContain("Bash");
    expect(allow).toContain("Read");
    expect(allow).toContain("mcp__atlassian__*");
    expect(allow).toContain("mcp__figma__*");
  });

  it("does not add implicit wildcard when tools already references that server", () => {
    const allow = buildPermissionsAllow({
      tools: ["Bash", "mcp__atlassian__getJiraIssue"],
      mcp_servers: ["atlassian"],
    });
    expect(allow).toContain("mcp__atlassian__getJiraIssue");
    expect(allow).not.toContain("mcp__atlassian__*");
  });

  it("respects explicit wildcards in tools without duplicating", () => {
    const allow = buildPermissionsAllow({
      tools: ["Bash", "mcp__atlassian__*"],
      mcp_servers: ["atlassian"],
    });
    const atlassianEntries = allow.filter((t) => t.startsWith("mcp__atlassian__"));
    expect(atlassianEntries).toEqual(["mcp__atlassian__*"]);
  });

  it("throws when tools references an undeclared MCP server", () => {
    expect(() => buildPermissionsAllow({
      tools: ["Bash", "mcp__github__createPullRequest"],
      mcp_servers: ["atlassian"],
    })).toThrow(/references MCP server 'github'/);
  });

  it("accepts inline-object mcp_servers entries", () => {
    const allow = buildPermissionsAllow({
      tools: ["Read"],
      mcp_servers: [{ atlassian: { command: "uvx", args: ["mcp-atlassian"] } }],
    });
    expect(allow).toContain("mcp__atlassian__*");
  });

  it("strips path and extension from string mcp_servers entries", () => {
    const allow = buildPermissionsAllow({
      tools: ["Read"],
      mcp_servers: ["/path/to/mcp-configs/atlassian.json"],
    });
    expect(allow).toContain("mcp__atlassian__*");
  });

  it("handles empty / missing fields gracefully", () => {
    expect(buildPermissionsAllow({})).toEqual([]);
    expect(buildPermissionsAllow({ tools: [] })).toEqual([]);
    expect(buildPermissionsAllow({ mcp_servers: [] })).toEqual([]);
  });
});

// ── writeHooksConfig: agent → permissions.allow integration ────────────────

describe("writeHooksConfig with agent", () => {
  it("writes permissions.allow from agent.tools when agent is provided", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: ["Bash", "Read", "Write"], mcp_servers: [] },
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toEqual(["Bash", "Read", "Write"]);
    expect(settings._ark?.managedAllow).toBe(true);
  });

  it("does not write permissions.allow when agent has no tools", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: [], mcp_servers: [] },
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions?.allow).toBeUndefined();
  });

  it("includes implicit mcp wildcards from declared servers", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: ["Bash"], mcp_servers: ["atlassian", "figma"] },
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("mcp__atlassian__*");
    expect(settings.permissions.allow).toContain("mcp__figma__*");
  });

  it("coexists with autonomy-driven permissions.deny", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir, {
      autonomy: "edit",
      agent: { tools: ["Bash", "Read", "Write", "Edit"], mcp_servers: [] },
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toEqual(["Bash", "Read", "Write", "Edit"]);
    expect(settings.permissions.deny).toEqual(["Bash"]);
  });

  it("throws when agent tools reference an undeclared MCP server", () => {
    expect(() => writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: ["mcp__github__createIssue"], mcp_servers: [] },
    })).toThrow(/references MCP server 'github'/);
  });

  it("idempotent: rewriting with the same agent produces the same allow list", () => {
    const agent = { tools: ["Bash", "Read"], mcp_servers: ["atlassian"] };
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir, { agent });
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir, { agent });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const allow = settings.permissions.allow;
    expect(allow).toEqual(["Bash", "Read", "mcp__atlassian__*"]);
  });
});

// ── removeHooksConfig: ark-managed permissions cleanup ────────────────────

describe("removeHooksConfig with agent permissions", () => {
  it("removes ark-managed allow list but preserves user allow entries added after", () => {
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: ["Bash", "Read"], mcp_servers: [] },
    });
    removeHooksConfig(getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions?.allow).toBeUndefined();
    expect(settings._ark).toBeUndefined();
  });

  it("preserves user-added permissions.allow when ark never managed one", () => {
    const claudeDir = join(getCtx().arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({
      permissions: { allow: ["UserTool"] },
    }));
    writeHooksConfig("s-test", "http://localhost:19100", getCtx().arkDir);
    removeHooksConfig(getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toEqual(["UserTool"]);
  });
});
