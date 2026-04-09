/**
 * Tests for skill store -- CRUD, three-tier resolution.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";

const { getCtx } = withTestContext();

describe("skill CRUD", () => {
  it("skills.list returns builtin skills", () => {
    const skills = getApp().skills.list();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some(s => s.name === "code-review")).toBe(true);
  });

  it("skills.get returns a skill by name", () => {
    const skill = getApp().skills.get("code-review");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("code-review");
    expect(skill!.description).toBeDefined();
    expect(skill!.prompt).toBeDefined();
  });

  it("skills.get returns null for unknown skill", () => {
    expect(getApp().skills.get("nonexistent")).toBeNull();
  });

  it("skills.save creates a global skill", () => {
    getApp().skills.save("my-skill", { name: "my-skill", description: "test", prompt: "do the thing" }, "global");
    const skill = getApp().skills.get("my-skill");
    expect(skill).not.toBeNull();
    expect(skill!._source).toBe("global");
  });

  it("skills.delete removes a global skill", () => {
    getApp().skills.save("to-delete", { name: "to-delete", description: "tmp", prompt: "x" }, "global");
    expect(getApp().skills.get("to-delete")).not.toBeNull();
    getApp().skills.delete("to-delete", "global");
    expect(getApp().skills.get("to-delete")).toBeNull();
  });

  it("project skills override global", () => {
    const projectRoot = getCtx().arkDir;
    getApp().skills.save("override-test", { name: "override-test", description: "global", prompt: "global" }, "global");
    getApp().skills.save("override-test", { name: "override-test", description: "project", prompt: "project" }, "project", projectRoot);
    const skill = getApp().skills.get("override-test", projectRoot);
    expect(skill!._source).toBe("project");
    expect(skill!.description).toBe("project");
  });
});
