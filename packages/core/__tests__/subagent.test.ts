import { describe, it, expect } from "bun:test";
import { createSession, getSession, updateSession } from "../store.js";
import { withTestContext } from "./test-helpers.js";

withTestContext();

// Import dynamically to avoid circular dep issues
const session = await import("../session.js");

describe("spawnSubagent", () => {
  it("creates a child session with parent reference", () => {
    const parent = createSession({ summary: "parent", repo: "/tmp/repo" });
    updateSession(parent.id, { agent: "implementer", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(parent.id, { task: "subtask" });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBeDefined();

    const child = getSession(result.sessionId!);
    expect(child).not.toBeNull();
    expect(child!.summary).toBe("subtask");
    expect(child!.parent_id).toBe(parent.id);
    expect(child!.agent).toBe("implementer");
  });

  it("allows model override", () => {
    const parent = createSession({ summary: "parent", repo: "/tmp/repo" });
    updateSession(parent.id, { agent: "worker", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(parent.id, {
      task: "cheap task",
      model: "haiku",
    });
    expect(result.ok).toBe(true);
    const child = getSession(result.sessionId!);
    expect((child!.config as any).model_override).toBe("haiku");
  });

  it("allows agent override", () => {
    const parent = createSession({ summary: "parent", repo: "/tmp/repo" });
    updateSession(parent.id, { agent: "implementer", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(parent.id, {
      task: "review task",
      agent: "reviewer",
    });
    const child = getSession(result.sessionId!);
    expect(child!.agent).toBe("reviewer");
  });

  it("rejects non-existent parent", () => {
    const result = session.spawnSubagent("nope", { task: "orphan" });
    expect(result.ok).toBe(false);
  });

  it("sets subagent config flag", () => {
    const parent = createSession({ summary: "parent", repo: "/tmp/repo" });
    updateSession(parent.id, { agent: "worker", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(parent.id, { task: "sub" });
    const child = getSession(result.sessionId!);
    expect((child!.config as any).subagent).toBe(true);
    expect((child!.config as any).parent_id).toBe(parent.id);
  });

  it("uses quick flow for subagents", () => {
    const parent = createSession({ summary: "parent", repo: "/tmp/repo" });
    updateSession(parent.id, { agent: "worker", workdir: "/tmp/repo" });

    const result = session.spawnSubagent(parent.id, { task: "sub" });
    const child = getSession(result.sessionId!);
    expect(child!.flow).toBe("quick");
  });
});

describe("sub-recipe composition", () => {
  it("listSubRecipes returns empty for recipes without sub_recipes", async () => {
    const { listSubRecipes } = await import("../recipe.js");
    const subs = listSubRecipes("quick-fix");
    expect(subs).toEqual([]);
  });
});
