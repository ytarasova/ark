/**
 * Tests for FileFlowStore - list, get, save, delete with three-tier resolution.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import YAML from "yaml";
import { FileFlowStore } from "../../stores/flow-store.js";

let store: FileFlowStore;
let builtinDir: string;
let userDir: string;
let projectDir: string;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ark-flow-store-test-"));
  builtinDir = join(tempDir, "builtin");
  userDir = join(tempDir, "user");
  projectDir = join(tempDir, "project");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  store = new FileFlowStore({ builtinDir, userDir, projectDir });
});

function writeFlow(dir: string, name: string, def: Record<string, unknown>): void {
  writeFileSync(join(dir, `${name}.yaml`), YAML.stringify(def));
}

// ── get ─────────────────────────────────────────────────────────────────────

describe("FileFlowStore.get", () => {
  it("returns null for non-existent flow", () => {
    expect(store.get("does-not-exist")).toBeNull();
  });

  it("loads a flow from builtin dir", () => {
    writeFlow(builtinDir, "test-flow", {
      name: "test-flow",
      description: "A test flow",
      stages: [{ name: "plan", agent: "planner", gate: "auto" }],
    });
    const flow = store.get("test-flow");
    expect(flow).not.toBeNull();
    expect(flow!.name).toBe("test-flow");
    expect(flow!.stages).toHaveLength(1);
  });

  it("user dir overrides builtin dir", () => {
    writeFlow(builtinDir, "shared", { name: "shared", description: "builtin", stages: [] });
    writeFlow(userDir, "shared", { name: "shared", description: "user", stages: [] });
    const flow = store.get("shared");
    expect(flow!.description).toBe("user");
  });

  it("project dir overrides user and builtin", () => {
    writeFlow(builtinDir, "shared", { name: "shared", description: "builtin", stages: [] });
    writeFlow(userDir, "shared", { name: "shared", description: "user", stages: [] });
    writeFlow(projectDir, "shared", { name: "shared", description: "project", stages: [] });
    const flow = store.get("shared");
    expect(flow!.description).toBe("project");
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe("FileFlowStore.list", () => {
  it("returns empty when no flows exist", () => {
    rmSync(builtinDir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    const storeEmpty = new FileFlowStore({
      builtinDir: join(tempDir, "gone-builtin"),
      userDir: join(tempDir, "gone-user"),
    });
    expect(storeEmpty.list()).toEqual([]);
  });

  it("lists flows from all tiers", () => {
    writeFlow(builtinDir, "b-only", { name: "b-only", stages: [{ name: "s1", gate: "auto" }] });
    writeFlow(userDir, "u-only", { name: "u-only", stages: [{ name: "s2", gate: "manual" }] });
    writeFlow(projectDir, "p-only", { name: "p-only", stages: [{ name: "s3", gate: "auto" }] });

    const flows = store.list();
    const names = flows.map(f => f.name);
    expect(names).toContain("b-only");
    expect(names).toContain("u-only");
    expect(names).toContain("p-only");
  });

  it("higher tier overrides lower tier with same name", () => {
    writeFlow(builtinDir, "overlap", { name: "overlap", description: "builtin", stages: [] });
    writeFlow(userDir, "overlap", { name: "overlap", description: "user", stages: [] });

    const flows = store.list();
    const overlap = flows.find(f => f.name === "overlap");
    expect(overlap).toBeDefined();
    expect(overlap!.source).toBe("user");
    expect(overlap!.description).toBe("user");
  });

  it("project tier wins in listing", () => {
    writeFlow(builtinDir, "overlap", { name: "overlap", description: "builtin", stages: [] });
    writeFlow(projectDir, "overlap", { name: "overlap", description: "project", stages: [] });

    const flows = store.list();
    const overlap = flows.find(f => f.name === "overlap");
    expect(overlap!.source).toBe("project");
  });

  it("returns stage names as string array", () => {
    writeFlow(builtinDir, "multi", {
      name: "multi",
      stages: [
        { name: "plan", gate: "auto" },
        { name: "impl", gate: "auto" },
      ],
    });
    const flows = store.list();
    const multi = flows.find(f => f.name === "multi");
    expect(multi!.stages).toEqual(["plan", "impl"]);
  });
});

// ── save ────────────────────────────────────────────────────────────────────

describe("FileFlowStore.save", () => {
  it("saves to user dir by default", () => {
    store.save("new-flow", { name: "new-flow", stages: [{ name: "s1", gate: "auto" } as any] });
    expect(existsSync(join(userDir, "new-flow.yaml"))).toBe(true);
    const loaded = store.get("new-flow");
    expect(loaded!.name).toBe("new-flow");
  });

  it("saves to project dir when scope is project", () => {
    store.save("proj-flow", { name: "proj-flow", stages: [] }, "project");
    expect(existsSync(join(projectDir, "proj-flow.yaml"))).toBe(true);
    expect(existsSync(join(userDir, "proj-flow.yaml"))).toBe(false);
  });
});

// ── delete ──────────────────────────────────────────────────────────────────

describe("FileFlowStore.delete", () => {
  it("returns false for non-existent flow", () => {
    expect(store.delete("ghost")).toBe(false);
  });

  it("deletes from user dir and returns true", () => {
    writeFlow(userDir, "to-del", { name: "to-del", stages: [] });
    expect(store.delete("to-del")).toBe(true);
    expect(existsSync(join(userDir, "to-del.yaml"))).toBe(false);
  });

  it("deletes from project dir when scope is project", () => {
    writeFlow(projectDir, "p-del", { name: "p-del", stages: [] });
    expect(store.delete("p-del", "project")).toBe(true);
    expect(existsSync(join(projectDir, "p-del.yaml"))).toBe(false);
  });
});

// ── no projectDir ───────────────────────────────────────────────────────────

describe("FileFlowStore without projectDir", () => {
  it("skips project tier when projectDir is not set", () => {
    writeFlow(projectDir, "proj-only", { name: "proj-only", stages: [] });
    const storeNoProject = new FileFlowStore({ builtinDir, userDir });
    expect(storeNoProject.get("proj-only")).toBeNull();
    const flows = storeNoProject.list();
    expect(flows.find(f => f.name === "proj-only")).toBeUndefined();
  });
});
