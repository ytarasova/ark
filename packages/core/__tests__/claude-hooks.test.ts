/**
 * Tests for claude.ts settings bundle -- writeSettings / removeSettings.
 */
import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { writeSettings, removeSettings, buildPermissionsAllow, buildToolHints } from "../claude/claude.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();

describe("writeSettings", () => {
  it("creates .claude/settings.local.json in workdir", () => {
    writeSettings("s-test123", "http://localhost:19100", getCtx().arkDir);
    expect(existsSync(join(getCtx().arkDir, ".claude", "settings.local.json"))).toBe(true);
  });

  it("contains hooks for all 9 events", () => {
    writeSettings("s-test123", "http://localhost:19100", getCtx().arkDir);
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
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.PreCompact[0].matcher).toBeUndefined();
    expect(settings.hooks.PostCompact[0].matcher).toBeUndefined();
  });

  it("hooks use command type with curl to correct conductor URL", () => {
    writeSettings("s-abc", "http://host.docker.internal:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("curl");
    expect(cmd).toContain("host.docker.internal:19100");
    expect(cmd).toContain("s-abc");
  });

  it("PreToolUse hook is sync, all others are async", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
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
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({ customKey: "preserved" }));

    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings.customKey).toBe("preserved");
    expect(settings.hooks).toBeDefined();
  });

  it("is idempotent -- calling twice doesn't duplicate hooks", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Stop.length).toBe(1);
  });

  it("includes session ID in hook command", () => {
    writeSettings("s-myid", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Stop[0].hooks[0].command).toContain("s-myid");
  });

  it("hook command is a single line (no newlines)", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).not.toContain("\n");
    expect(cmd.split("\n").length).toBe(1);
  });

  it("hook command suppresses curl output", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("> /dev/null 2>&1");
  });

  it("SessionStart has startup|resume matcher", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.SessionStart[0].matcher).toBe("startup|resume");
  });

  it("Notification has permission_prompt|idle_prompt matcher", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.hooks.Notification[0].matcher).toBe("permission_prompt|idle_prompt");
  });
});

describe("removeSettings", () => {
  it("removes ark hooks but preserves other settings", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    // Add extra settings
    const settingsPath = join(getCtx().arkDir, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    settings.customKey = "preserved";
    writeFileSync(settingsPath, JSON.stringify(settings));

    removeSettings(getCtx().arkDir);
    const cleaned = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(cleaned.customKey).toBe("preserved");
    expect(cleaned.hooks).toBeUndefined();
  });

  it("does nothing if no settings file exists", () => {
    expect(() => removeSettings(getCtx().arkDir)).not.toThrow();
  });

  it("preserves non-ark hooks", () => {
    const claudeDir = join(getCtx().arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "my-custom-hook.sh", async: true }] }],
        },
      }),
    );

    // Add ark hooks on top
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);

    // Remove ark hooks
    removeSettings(getCtx().arkDir);

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
    expect(() =>
      buildPermissionsAllow({
        tools: ["Bash", "mcp__github__createPullRequest"],
        mcp_servers: ["atlassian"],
      }),
    ).toThrow(/references MCP server 'github'/);
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

// ── writeSettings: agent → permissions.allow integration ────────────────

describe("writeSettings with agent", () => {
  it("writes permissions.allow from agent.tools when agent is provided", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: ["Bash", "Read", "Write"], mcp_servers: [] },
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Write");
    expect(settings.permissions.allow).toContain("mcp__ark-channel__*");
    expect(settings._ark?.managedAllow).toBe(true);
  });

  it("always includes mcp__ark-channel__* even when agent has no tools", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: [], mcp_servers: [] },
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("mcp__ark-channel__*");
  });

  it("does not write permissions.allow when no agent is provided", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions).toBeUndefined();
  });

  it("includes mcp__ark-channel__* when agent.tools and mcp_servers are undefined", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: {},
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("mcp__ark-channel__*");
  });

  it("includes implicit mcp wildcards from declared servers", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: ["Bash"], mcp_servers: ["atlassian", "figma"] },
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("mcp__atlassian__*");
    expect(settings.permissions.allow).toContain("mcp__figma__*");
    expect(settings.permissions.allow).toContain("mcp__ark-channel__*");
  });

  it("coexists with autonomy-driven permissions.deny", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, {
      autonomy: "edit",
      agent: { tools: ["Bash", "Read", "Write", "Edit"], mcp_servers: [] },
    });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.allow).toContain("Read");
    expect(settings.permissions.allow).toContain("Write");
    expect(settings.permissions.allow).toContain("Edit");
    expect(settings.permissions.allow).toContain("mcp__ark-channel__*");
    expect(settings.permissions.deny).toEqual(["Bash"]);
  });

  it("throws when agent tools reference an undeclared MCP server", () => {
    expect(() =>
      writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, {
        agent: { tools: ["mcp__github__createIssue"], mcp_servers: [] },
      }),
    ).toThrow(/references MCP server 'github'/);
  });

  it("idempotent: rewriting with the same agent produces the same allow list", () => {
    const agent = { tools: ["Bash", "Read"], mcp_servers: ["atlassian"] };
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, { agent });
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, { agent });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    const allow = settings.permissions.allow;
    expect(allow).toEqual(["Bash", "Read", "mcp__atlassian__*", "mcp__ark-channel__*"]);
  });
});

// ── removeSettings: ark-managed permissions cleanup ────────────────────

// ── buildToolHints unit tests ───────────────────────────────────────────────

describe("buildToolHints", () => {
  it("returns empty string when agent has no tools and no mcp_servers", () => {
    expect(buildToolHints({})).toBe("");
    expect(buildToolHints({ tools: [] })).toBe("");
    expect(buildToolHints({ tools: [], mcp_servers: [] })).toBe("");
  });

  it("lists built-in tools in the Built-in section", () => {
    const hint = buildToolHints({ tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] });
    expect(hint).toContain("## Available tools");
    expect(hint).toContain("**Built-in:** Bash, Read, Write, Edit, Glob, Grep");
  });

  it("lists declared MCP servers with their call prefix", () => {
    const hint = buildToolHints({ tools: ["Read"], mcp_servers: ["atlassian", "figma"] });
    expect(hint).toContain("**MCP servers:**");
    expect(hint).toContain("`atlassian` -- call via `mcp__atlassian__<toolName>`");
    expect(hint).toContain("`figma` -- call via `mcp__figma__<toolName>`");
  });

  it("surfaces explicitly-granted MCP tools in their own section", () => {
    const hint = buildToolHints({
      tools: ["Read", "mcp__atlassian__getJiraIssue", "mcp__atlassian__addCommentToJiraIssue"],
      mcp_servers: ["atlassian"],
    });
    expect(hint).toContain(
      "**Specific MCP tools granted:** mcp__atlassian__getJiraIssue, mcp__atlassian__addCommentToJiraIssue",
    );
  });

  it("wildcards like mcp__atlassian__* do not appear in the Specific section", () => {
    const hint = buildToolHints({
      tools: ["Read", "mcp__atlassian__*"],
      mcp_servers: ["atlassian"],
    });
    expect(hint).not.toContain("**Specific MCP tools granted:**");
  });

  it("always includes the do-not-probe instruction when any tools are declared", () => {
    const hint = buildToolHints({ tools: ["Bash"] });
    expect(hint).toContain("Do not probe, list, or ask which tools exist");
  });

  it("accepts inline-object mcp_servers entries and extracts the server name", () => {
    const hint = buildToolHints({
      tools: ["Read"],
      mcp_servers: [{ atlassian: { command: "uvx", args: ["mcp-atlassian"] } }],
    });
    expect(hint).toContain("`atlassian` -- call via `mcp__atlassian__<toolName>`");
  });
});

describe("removeSettings with agent permissions", () => {
  it("removes ark-managed allow list but preserves user allow entries added after", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, {
      agent: { tools: ["Bash", "Read"], mcp_servers: [] },
    });
    removeSettings(getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions?.allow).toBeUndefined();
    expect(settings._ark).toBeUndefined();
  });

  it("preserves pre-existing allow list when no agent was provided", () => {
    const claudeDir = join(getCtx().arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({
        permissions: { allow: ["UserTool"] },
      }),
    );
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    removeSettings(getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    // No agent = no managedAllow, so user's pre-existing allow list is preserved
    expect(settings.permissions?.allow).toEqual(["UserTool"]);
  });
});
