import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "../app.js";

const { getCtx } = withTestContext();

describe("skill create/delete via core", () => {
  it("skills.save creates a global skill and skills.get finds it", () => {
    getApp().skills.save("test-skill", { name: "test-skill", description: "Test", prompt: "Do the thing" }, "global");
    const skill = getApp().skills.get("test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("test-skill");
    expect(skill!.prompt).toBe("Do the thing");
    expect(skill!._source).toBe("global");
  });

  it("skills.delete removes a global skill", () => {
    getApp().skills.save("ephemeral", { name: "ephemeral", description: "tmp", prompt: "x" }, "global");
    expect(getApp().skills.get("ephemeral")).not.toBeNull();
    getApp().skills.delete("ephemeral", "global");
    expect(getApp().skills.get("ephemeral")).toBeNull();
  });

  it("skills.delete on a builtin name does not remove builtins", () => {
    const builtins = getApp().skills.list();
    const builtinName = builtins.find(s => s._source === "builtin")?.name;
    if (builtinName) {
      getApp().skills.delete(builtinName, "global");
      expect(getApp().skills.get(builtinName)).not.toBeNull();
    }
  });

  it("skills.save with tags round-trips via YAML", () => {
    const skill = { name: "from-file", description: "From file", prompt: "multi\nline\nprompt", tags: ["test"] };
    getApp().skills.save("from-file", skill, "global");
    const loaded = getApp().skills.get("from-file");
    expect(loaded!.prompt).toBe("multi\nline\nprompt");
    expect(loaded!.tags).toEqual(["test"]);
  });
});
