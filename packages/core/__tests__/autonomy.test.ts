/**
 * Tests for tiered autonomy -- full/execute/edit/read-only per flow stage.
 *
 * Covers: buildArgs permission gating, writeSettings permission deny rules,
 * flow YAML loading with autonomy field, and resolveFlow preservation.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import { buildArgs, writeSettings } from "../claude/claude.js";
import { resolveFlow } from "../state/flow.js";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

const { getCtx } = withTestContext();

const flowDir = () => join(getApp().config.arkDir, "flows");

function writeUserFlow(name: string, def: Record<string, unknown>): void {
  const dir = flowDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

beforeEach(() => {
  rmSync(flowDir(), { recursive: true, force: true });
});

// ── buildArgs autonomy ───────────────────────────────────────────────────────

describe("buildArgs autonomy", () => {
  it("no autonomy (default) includes --dangerously-skip-permissions", () => {
    const args = buildArgs({});
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("autonomy 'full' includes --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "full" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("autonomy 'execute' includes --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "execute" });
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("autonomy 'edit' does NOT include --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "edit" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("autonomy 'read-only' does NOT include --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "read-only" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("autonomy 'edit' in headless mode also omits --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "edit", headless: true, task: "test task" });
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).toContain("-p");
    expect(args).toContain("--verbose");
  });

  it("autonomy 'read-only' in headless mode also omits --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "read-only", headless: true, task: "test task" });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("autonomy 'full' in headless mode includes --dangerously-skip-permissions", () => {
    const args = buildArgs({ autonomy: "full", headless: true, task: "test task" });
    expect(args).toContain("--dangerously-skip-permissions");
  });
});

// ── writeSettings autonomy ────────────────────────────────────────────────

describe("writeSettings autonomy", () => {
  it("autonomy 'edit' adds permissions.deny: ['Bash']", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, { autonomy: "edit" });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.deny).toEqual(["Bash"]);
  });

  it("autonomy 'read-only' adds permissions.deny: ['Bash', 'Write', 'Edit']", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, { autonomy: "read-only" });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.deny).toEqual(["Bash", "Write", "Edit"]);
  });

  it("autonomy 'full' does NOT add permissions.deny", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, { autonomy: "full" });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions).toBeUndefined();
  });

  it("no autonomy does NOT add permissions.deny", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir);
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions).toBeUndefined();
  });

  it("autonomy 'execute' does NOT add permissions.deny", () => {
    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, { autonomy: "execute" });
    const settings = JSON.parse(readFileSync(join(getCtx().arkDir, ".claude", "settings.local.json"), "utf-8"));
    expect(settings.permissions).toBeUndefined();
  });

  it("autonomy 'edit' preserves existing settings alongside deny rules", () => {
    const claudeDir = join(getCtx().arkDir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify({
      permissions: { allow: ["Read"] },
    }));

    writeSettings("s-test", "http://localhost:19100", getCtx().arkDir, { autonomy: "edit" });
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf-8"));
    expect(settings.permissions.allow).toEqual(["Read"]);
    expect(settings.permissions.deny).toEqual(["Bash"]);
    expect(settings.hooks).toBeDefined();
  });
});

// ── Flow YAML with autonomy ──────────────────────────────────────────────────

describe("flow autonomy field", () => {
  it("loads flow YAML with autonomy 'read-only' on a stage", () => {
    writeUserFlow("autonomy-flow", {
      name: "autonomy-flow",
      stages: [
        { name: "review", agent: "reviewer", gate: "auto", autonomy: "read-only" },
        { name: "implement", agent: "worker", gate: "auto", autonomy: "full" },
      ],
    });

    const flow = getApp().flows.get("autonomy-flow");
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].autonomy).toBe("read-only");
    expect(flow!.stages[1].autonomy).toBe("full");
  });

  it("autonomy field is undefined when not set in YAML", () => {
    writeUserFlow("no-autonomy-flow", {
      name: "no-autonomy-flow",
      stages: [
        { name: "work", agent: "worker", gate: "auto" },
      ],
    });

    const flow = getApp().flows.get("no-autonomy-flow");
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].autonomy).toBeUndefined();
  });

  it("resolveFlow preserves autonomy field after variable substitution", () => {
    writeUserFlow("resolve-autonomy", {
      name: "resolve-autonomy",
      stages: [
        { name: "plan", agent: "planner", gate: "auto", autonomy: "edit", task: "Plan {ticket}" },
        { name: "impl", agent: "worker", gate: "auto", autonomy: "execute", task: "Build {ticket}" },
        { name: "review", agent: "reviewer", gate: "auto", autonomy: "read-only" },
      ],
    });

    const flow = resolveFlow(getApp(), "resolve-autonomy", { ticket: "PROJ-1" });
    expect(flow).not.toBeNull();
    expect(flow!.stages[0].autonomy).toBe("edit");
    expect(flow!.stages[0].task).toBe("Plan PROJ-1");
    expect(flow!.stages[1].autonomy).toBe("execute");
    expect(flow!.stages[1].task).toBe("Build PROJ-1");
    expect(flow!.stages[2].autonomy).toBe("read-only");
  });
});
