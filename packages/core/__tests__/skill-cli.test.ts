import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { saveSkill, deleteSkill, loadSkill, listSkills } from "../skill.js";

const { getCtx } = withTestContext();

describe("skill create/delete via core", () => {
  it("saveSkill creates a global skill and loadSkill finds it", () => {
    saveSkill({ name: "test-skill", description: "Test", prompt: "Do the thing" }, "global");
    const skill = loadSkill("test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("test-skill");
    expect(skill!.prompt).toBe("Do the thing");
    expect(skill!._source).toBe("global");
  });

  it("deleteSkill removes a global skill", () => {
    saveSkill({ name: "ephemeral", description: "tmp", prompt: "x" }, "global");
    expect(loadSkill("ephemeral")).not.toBeNull();
    deleteSkill("ephemeral", "global");
    expect(loadSkill("ephemeral")).toBeNull();
  });

  it("deleteSkill on a builtin name does not remove builtins", () => {
    const builtins = listSkills();
    const builtinName = builtins.find(s => s._source === "builtin")?.name;
    if (builtinName) {
      deleteSkill(builtinName, "global");
      expect(loadSkill(builtinName)).not.toBeNull();
    }
  });

  it("saveSkill with tags round-trips via YAML", () => {
    const skill = { name: "from-file", description: "From file", prompt: "multi\nline\nprompt", tags: ["test"] };
    saveSkill(skill, "global");
    const loaded = loadSkill("from-file");
    expect(loaded!.prompt).toBe("multi\nline\nprompt");
    expect(loaded!.tags).toEqual(["test"]);
  });
});
