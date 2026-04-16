import { describe, it, expect } from "bun:test";
import { getApp } from "../app.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

// Import dynamically to avoid circular dep issues
const session = await import("../services/session-orchestration.js");

describe("spawnSubagent", () => {
  it("creates a child session with parent reference", () => {
    const parent = getApp().sessions.create({ summary: "parent", repo: "/tmp/repo" });
    getApp().sessions.update(parent.id, { agent: "implementer", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(getApp(), parent.id, { task: "subtask" });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    const child = getApp().sessions.get(result.sessionId!);
    expect(child).not.toBeNull();
    expect(child!.summary).toBe("subtask");
    expect(child!.parent_id).toBe(parent.id);
    expect(child!.agent).toBe("implementer");
  });

  it("allows model override", () => {
    const parent = getApp().sessions.create({ summary: "parent", repo: "/tmp/repo" });
    getApp().sessions.update(parent.id, { agent: "worker", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(getApp(), parent.id, {
      task: "cheap task",
      model: "haiku",
    });
    expect(result.ok).toBe(true);
    const child = getApp().sessions.get(result.sessionId!);
    expect(child!.config.model_override).toBe("haiku");
  });

  it("allows agent override", () => {
    const parent = getApp().sessions.create({ summary: "parent", repo: "/tmp/repo" });
    getApp().sessions.update(parent.id, { agent: "implementer", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(getApp(), parent.id, {
      task: "review task",
      agent: "reviewer",
    });
    const child = getApp().sessions.get(result.sessionId!);
    expect(child!.agent).toBe("reviewer");
  });

  it("rejects non-existent parent", () => {
    const result = session.spawnSubagent(getApp(), "nope", { task: "orphan" });
    expect(result.ok).toBe(false);
  });

  it("sets subagent config flag", () => {
    const parent = getApp().sessions.create({ summary: "parent", repo: "/tmp/repo" });
    getApp().sessions.update(parent.id, { agent: "worker", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(getApp(), parent.id, { task: "sub" });
    const child = getApp().sessions.get(result.sessionId!);
    expect(child!.config.subagent).toBe(true);
    expect(child!.config.parent_id).toBe(parent.id);
  });

  it("uses quick flow for subagents", () => {
    const parent = getApp().sessions.create({ summary: "parent", repo: "/tmp/repo" });
    getApp().sessions.update(parent.id, { agent: "worker", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(getApp(), parent.id, { task: "sub" });
    const child = getApp().sessions.get(result.sessionId!);
    expect(child!.flow).toBe("quick");
  });
});

describe("sub-recipe composition", () => {
  it("listSubRecipes returns empty for recipes without sub_recipes", async () => {
    const { listSubRecipes } = await import("../agent/recipe.js");
    const subs = listSubRecipes(getApp(), "quick-fix");
    expect(subs).toEqual([]);
  });
});
