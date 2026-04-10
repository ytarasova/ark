/**
 * E2E tests for tiered autonomy — full pipeline from flow YAML through
 * argument building and settings.local.json permission deny rules.
 *
 * Tests: flow YAML with autonomy -> resolveFlow preserves it -> buildArgs
 * permission gating -> writeHooksConfig deny rules -> buildClaudeArgs forwarding.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { buildArgs, writeHooksConfig, removeHooksConfig } from "../claude/claude.js";
import { resolveFlow } from "../state/flow.js";
import { buildClaudeArgs } from "../agent/agent.js";
import { buildSessionVars } from "../template.js";

let app: AppContext;

const flowDir = () => join(getApp().config.arkDir, "flows");

function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(async () => {
  if (app) { await app.shutdown(); clearApp(); }
  app = AppContext.forTest();
  setApp(app);
  await app.boot();
  rmSync(flowDir(), { recursive: true, force: true });
});

afterAll(async () => {
  if (app) { await app.shutdown(); clearApp(); }
});

// -- Flow YAML -> resolveFlow -> autonomy preserved ---------------------------

describe("E2E: flow YAML autonomy through resolveFlow", () => {
  it("write flow with read-only stage, resolveFlow preserves autonomy", () => {
    writeUserFlow("review-pipeline", {
      name: "review-pipeline",
      stages: [
        { name: "review", agent: "reviewer", gate: "auto", autonomy: "read-only", task: "Review {ticket}" },
        { name: "implement", agent: "worker", gate: "auto", autonomy: "full", task: "Implement {ticket}" },
      ],
    });

    // flows.get preserves raw autonomy
    const raw = getApp().flows.get("review-pipeline");
    expect(raw).not.toBeNull();
    expect(raw!.stages[0].autonomy).toBe("read-only");
    expect(raw!.stages[1].autonomy).toBe("full");

    // resolveFlow preserves autonomy after variable substitution
    const resolved = resolveFlow("review-pipeline", { ticket: "PROJ-42" });
    expect(resolved).not.toBeNull();
    expect(resolved!.stages[0].autonomy).toBe("read-only");
    expect(resolved!.stages[0].task).toBe("Review PROJ-42");
    expect(resolved!.stages[1].autonomy).toBe("full");
    expect(resolved!.stages[1].task).toBe("Implement PROJ-42");
  });

  it("flow with all four autonomy levels preserves each through resolveFlow", () => {
    writeUserFlow("tiered-flow", {
      name: "tiered-flow",
      stages: [
        { name: "plan", agent: "planner", gate: "auto", autonomy: "read-only" },
        { name: "design", agent: "designer", gate: "auto", autonomy: "edit" },
        { name: "build", agent: "builder", gate: "auto", autonomy: "execute" },
        { name: "deploy", agent: "deployer", gate: "auto", autonomy: "full" },
      ],
    });

    const resolved = resolveFlow("tiered-flow", { ticket: "X" });
    expect(resolved!.stages[0].autonomy).toBe("read-only");
    expect(resolved!.stages[1].autonomy).toBe("edit");
    expect(resolved!.stages[2].autonomy).toBe("execute");
    expect(resolved!.stages[3].autonomy).toBe("full");
  });

  it("flow without autonomy field leaves it undefined", () => {
    writeUserFlow("no-autonomy", {
      name: "no-autonomy",
      stages: [
        { name: "work", agent: "worker", gate: "auto", task: "Do work" },
      ],
    });

    const resolved = resolveFlow("no-autonomy", {});
    expect(resolved!.stages[0].autonomy).toBeUndefined();
  });
});

// -- buildArgs autonomy gating ------------------------------------------------

describe("E2E: buildArgs permission gating by autonomy", () => {
  it("read-only does NOT include --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "read-only" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("edit does NOT include --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "edit" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("execute DOES include --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "execute" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("full DOES include --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "full" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("no autonomy (default) includes --dangerously-skip-permissions", () => {
    const args = buildArgs({});
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("headless mode respects autonomy gating too", () => {
    const readOnlyHeadless = buildArgs({ autonomy: "read-only", headless: true, task: "test" });
    expect(readOnlyHeadless).not.toContain("--dangerously-skip-permissions");
    expect(readOnlyHeadless).toContain("-p");

    const fullHeadless = buildArgs({ autonomy: "full", headless: true, task: "test" });
    expect(fullHeadless).toContain("--dangerously-skip-permissions");
  });
});

// -- writeHooksConfig deny rules ----------------------------------------------

describe("E2E: writeHooksConfig writes permission deny rules", () => {
  it("read-only writes deny: ['Bash', 'Write', 'Edit'] to settings.local.json", () => {
    writeHooksConfig("s-e2e", "http://localhost:19100", app.config.arkDir, { autonomy: "read-only" });

    const settingsPath = join(app.config.arkDir, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.deny).toEqual(["Bash", "Write", "Edit"]);
    // Hooks should also be written
    expect(settings.hooks).toBeDefined();
  });

  it("edit writes deny: ['Bash'] to settings.local.json", () => {
    writeHooksConfig("s-e2e", "http://localhost:19100", app.config.arkDir, { autonomy: "edit" });

    const settings = JSON.parse(
      readFileSync(join(app.config.arkDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.permissions.deny).toEqual(["Bash"]);
  });

  it("full does NOT add permissions.deny", () => {
    writeHooksConfig("s-e2e", "http://localhost:19100", app.config.arkDir, { autonomy: "full" });

    const settings = JSON.parse(
      readFileSync(join(app.config.arkDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.permissions).toBeUndefined();
  });

  it("execute does NOT add permissions.deny", () => {
    writeHooksConfig("s-e2e", "http://localhost:19100", app.config.arkDir, { autonomy: "execute" });

    const settings = JSON.parse(
      readFileSync(join(app.config.arkDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.permissions).toBeUndefined();
  });

  it("no autonomy does NOT add permissions.deny", () => {
    writeHooksConfig("s-e2e", "http://localhost:19100", app.config.arkDir);

    const settings = JSON.parse(
      readFileSync(join(app.config.arkDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.permissions).toBeUndefined();
  });

  it("edit preserves existing allow rules alongside new deny rules", () => {
    // Pre-populate settings with existing allow rules
    const claudeDir = join(app.config.arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Read", "Glob"] },
    }));

    writeHooksConfig("s-e2e", "http://localhost:19100", app.config.arkDir, { autonomy: "edit" });

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toEqual(["Read", "Glob"]);
    expect(settings.permissions.deny).toEqual(["Bash"]);
    expect(settings.hooks).toBeDefined();
  });

  it("removeHooksConfig cleans up hooks but does not crash", () => {
    writeHooksConfig("s-e2e", "http://localhost:19100", app.config.arkDir, { autonomy: "read-only" });
    // removeHooksConfig should not throw
    removeHooksConfig(app.config.arkDir);
    // After removal, hooks should be gone
    const settings = JSON.parse(
      readFileSync(join(app.config.arkDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.hooks).toBeUndefined();
  });
});

// -- buildClaudeArgs forwards autonomy ----------------------------------------

describe("E2E: buildClaudeArgs forwards autonomy from agent", () => {
  const testAgent = {
    name: "test-agent",
    description: "test",
    model: "sonnet",
    max_turns: 10,
    system_prompt: "You are a test agent",
    tools: [],
    mcp_servers: [],
    skills: [],
    memories: [],
    context: [],
    permission_mode: "bypassPermissions",
    env: {},
  };

  it("read-only forwarded -> no --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs(testAgent, { autonomy: "read-only" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("edit forwarded -> no --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs(testAgent, { autonomy: "edit" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("full forwarded -> includes --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs(testAgent, { autonomy: "full" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("execute forwarded -> includes --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs(testAgent, { autonomy: "execute" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("no autonomy forwarded -> includes --dangerously-skip-permissions (default)", () => {
    const args = buildClaudeArgs(testAgent);
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("headless + read-only forwarded -> no --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs(testAgent, {
      autonomy: "read-only",
      headless: true,
      task: "review code",
    });
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("-p");
    expect(args).toContain("review code");
  });
});

// -- Full pipeline: flow YAML -> buildArgs -> writeHooksConfig ----------------

describe("E2E: full autonomy pipeline", () => {
  it("flow stage autonomy drives both arg building and hooks config", () => {
    writeUserFlow("full-pipeline", {
      name: "full-pipeline",
      stages: [
        { name: "analyze", agent: "analyst", gate: "auto", autonomy: "read-only", task: "Analyze {repo}" },
        { name: "implement", agent: "coder", gate: "auto", autonomy: "full", task: "Code {ticket}" },
      ],
    });

    const vars = buildSessionVars({ id: "s-pipe", ticket: "PIPE-1", repo: "/app" });
    const flow = resolveFlow("full-pipeline", vars);
    expect(flow).not.toBeNull();

    // Stage 0: read-only
    const s0 = flow!.stages[0];
    expect(s0.autonomy).toBe("read-only");
    expect(s0.task).toBe("Analyze /app");

    const args0 = buildArgs({ autonomy: s0.autonomy });
    expect(args0).not.toContain("--dangerously-skip-permissions");

    writeHooksConfig("s-pipe-0", "http://localhost:19100", app.config.arkDir, { autonomy: s0.autonomy });
    const settings0 = JSON.parse(
      readFileSync(join(app.config.arkDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings0.permissions.deny).toEqual(["Bash", "Write", "Edit"]);

    // Clean up for stage 1
    rmSync(join(app.config.arkDir, ".claude"), { recursive: true, force: true });

    // Stage 1: full
    const s1 = flow!.stages[1];
    expect(s1.autonomy).toBe("full");
    expect(s1.task).toBe("Code PIPE-1");

    const args1 = buildArgs({ autonomy: s1.autonomy });
    expect(args1).toContain("--dangerously-skip-permissions");

    writeHooksConfig("s-pipe-1", "http://localhost:19100", app.config.arkDir, { autonomy: s1.autonomy });
    const settings1 = JSON.parse(
      readFileSync(join(app.config.arkDir, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings1.permissions).toBeUndefined();
  });
});
