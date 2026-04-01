/**
 * Tests for skill.ts — CRUD, three-tier resolution.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { listSkills, loadSkill, saveSkill, deleteSkill } from "../skill.js";

const { getCtx } = withTestContext();

describe("skill CRUD", () => {
  it("listSkills returns builtin skills", () => {
    const skills = listSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some(s => s.name === "code-review")).toBe(true);
  });

  it("loadSkill returns a skill by name", () => {
    const skill = loadSkill("code-review");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("code-review");
    expect(skill!.description).toBeDefined();
    expect(skill!.prompt).toBeDefined();
  });

  it("loadSkill returns null for unknown skill", () => {
    expect(loadSkill("nonexistent")).toBeNull();
  });

  it("saveSkill creates a global skill", () => {
    saveSkill({ name: "my-skill", description: "test", prompt: "do the thing" }, "global");
    const skill = loadSkill("my-skill");
    expect(skill).not.toBeNull();
    expect(skill!._source).toBe("global");
  });

  it("deleteSkill removes a global skill", () => {
    saveSkill({ name: "to-delete", description: "tmp", prompt: "x" }, "global");
    expect(loadSkill("to-delete")).not.toBeNull();
    deleteSkill("to-delete", "global");
    expect(loadSkill("to-delete")).toBeNull();
  });

  it("project skills override global", () => {
    const projectRoot = getCtx().arkDir;
    saveSkill({ name: "override-test", description: "global", prompt: "global" }, "global");
    saveSkill({ name: "override-test", description: "project", prompt: "project" }, "project", projectRoot);
    const skill = loadSkill("override-test", projectRoot);
    expect(skill!._source).toBe("project");
    expect(skill!.description).toBe("project");
  });
});
