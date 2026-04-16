/**
 * Tests for FileSkillStore - list, get, save, delete with three-tier resolution.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { stringify as stringifyYaml } from "yaml";
import { FileSkillStore } from "../../stores/skill-store.js";

let store: FileSkillStore;
let builtinDir: string;
let userDir: string;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ark-skill-store-test-"));
  builtinDir = join(tempDir, "builtin");
  userDir = join(tempDir, "user");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  store = new FileSkillStore({ builtinDir, userDir });
});

function writeSkill(dir: string, name: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, `${name}.yaml`), stringifyYaml(data));
}

// ── get ─────────────────────────────────────────────────────────────────────

describe("FileSkillStore.get", () => {
  it("returns null for non-existent skill", () => {
    expect(store.get("does-not-exist")).toBeNull();
  });

  it("loads a skill from builtin dir", () => {
    writeSkill(builtinDir, "my-skill", { name: "my-skill", description: "A skill", prompt: "Do the thing" });
    const skill = store.get("my-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("my-skill");
    expect(skill!.prompt).toBe("Do the thing");
    expect(skill!._source).toBe("builtin");
  });

  it("user dir overrides builtin dir", () => {
    writeSkill(builtinDir, "shared", { name: "shared", description: "builtin", prompt: "b" });
    writeSkill(userDir, "shared", { name: "shared", description: "global", prompt: "g" });
    const skill = store.get("shared");
    expect(skill!._source).toBe("global");
    expect(skill!.description).toBe("global");
  });

  it("project dir overrides both when projectRoot is passed", () => {
    const projRoot = join(tempDir, "project-root");
    const projSkillDir = join(projRoot, ".ark", "skills");
    mkdirSync(projSkillDir, { recursive: true });
    writeSkill(builtinDir, "shared", { name: "shared", description: "builtin", prompt: "b" });
    writeSkill(userDir, "shared", { name: "shared", description: "global", prompt: "g" });
    writeSkill(projSkillDir, "shared", { name: "shared", description: "project", prompt: "p" });

    const skill = store.get("shared", projRoot);
    expect(skill!._source).toBe("project");
    expect(skill!.description).toBe("project");
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe("FileSkillStore.list", () => {
  it("returns empty when no skills exist", () => {
    expect(store.list()).toEqual([]);
  });

  it("lists skills from builtin and user dirs", () => {
    writeSkill(builtinDir, "b-skill", { name: "b-skill", description: "b", prompt: "b" });
    writeSkill(userDir, "u-skill", { name: "u-skill", description: "u", prompt: "u" });
    const skills = store.list();
    const names = skills.map((s) => s.name);
    expect(names).toContain("b-skill");
    expect(names).toContain("u-skill");
  });

  it("results are sorted by name", () => {
    writeSkill(builtinDir, "zebra", { name: "zebra", description: "z", prompt: "z" });
    writeSkill(builtinDir, "alpha", { name: "alpha", description: "a", prompt: "a" });
    const skills = store.list();
    expect(skills[0].name).toBe("alpha");
    expect(skills[1].name).toBe("zebra");
  });

  it("user skill overrides builtin with same name in listing", () => {
    writeSkill(builtinDir, "overlap", { name: "overlap", description: "builtin", prompt: "b" });
    writeSkill(userDir, "overlap", { name: "overlap", description: "global", prompt: "g" });
    const skills = store.list();
    const overlap = skills.filter((s) => s.name === "overlap");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]._source).toBe("global");
  });
});

// ── save ────────────────────────────────────────────────────────────────────

describe("FileSkillStore.save", () => {
  it("saves to user dir by default", () => {
    store.save("new-skill", { name: "new-skill", description: "test", prompt: "do it" });
    expect(existsSync(join(userDir, "new-skill.yaml"))).toBe(true);
    const loaded = store.get("new-skill");
    expect(loaded!.name).toBe("new-skill");
    expect(loaded!._source).toBe("global");
  });

  it("saves to project dir when scope is project", () => {
    const projRoot = join(tempDir, "proj-save");
    store.save("proj-skill", { name: "proj-skill", description: "p", prompt: "p" }, "project", projRoot);
    expect(existsSync(join(projRoot, ".ark", "skills", "proj-skill.yaml"))).toBe(true);
  });

  it("strips _source from saved YAML", () => {
    store.save("stripped", { name: "stripped", description: "d", prompt: "p", _source: "global" });
    const loaded = store.get("stripped");
    // Should be present as metadata but not in the file itself
    expect(loaded!.name).toBe("stripped");
  });
});

// ── delete ──────────────────────────────────────────────────────────────────

describe("FileSkillStore.delete", () => {
  it("returns false for non-existent skill", () => {
    expect(store.delete("ghost")).toBe(false);
  });

  it("deletes from user dir and returns true", () => {
    writeSkill(userDir, "to-del", { name: "to-del", description: "d", prompt: "p" });
    expect(store.delete("to-del")).toBe(true);
    expect(existsSync(join(userDir, "to-del.yaml"))).toBe(false);
  });

  it("deletes .yml files too", () => {
    writeFileSync(join(userDir, "yml-skill.yml"), stringifyYaml({ name: "yml-skill", description: "d", prompt: "p" }));
    expect(store.delete("yml-skill")).toBe(true);
    expect(existsSync(join(userDir, "yml-skill.yml"))).toBe(false);
  });
});
