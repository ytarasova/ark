// packages/core/__tests__/v05-gaps-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../app.js";
import * as core from "../index.js";
import type { RecipeDefinition } from "../../types/index.js";
import { clearApp, getApp, setApp } from "./test-helpers.js";

let app: AppContext;
beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});
afterEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
});

describe("v0.5 gaps integration", async () => {
  it("skill create -> list -> delete round-trip", () => {
    getApp().skills.save("int-test", { name: "int-test", description: "Integration", prompt: "test prompt" }, "global");
    const found = getApp()
      .skills.list()
      .find((s) => s.name === "int-test");
    expect(found).toBeDefined();
    expect(found!._source).toBe("global");

    getApp().skills.delete("int-test", "global");
    expect(getApp().skills.get("int-test")).toBeNull();
  });

  it("recipe create -> list -> delete round-trip", () => {
    getApp().recipes.save(
      "int-recipe",
      {
        name: "int-recipe",
        description: "Integration recipe",
        flow: "bare",
        variables: [],
      } as RecipeDefinition,
      "global",
    );
    const found = getApp()
      .recipes.list()
      .find((r) => r.name === "int-recipe");
    expect(found).toBeDefined();

    getApp().recipes.delete("int-recipe", "global");
    expect(getApp().recipes.get("int-recipe")).toBeNull();
  });

  it("sessionToRecipe creates valid recipe from session", async () => {
    const session = await app.sessions.create({ summary: "Integration test", flow: "default" });
    const recipe = core.sessionToRecipe(session, "from-int-test");
    expect(recipe.name).toBe("from-int-test");
    expect(recipe.flow).toBe("default");

    getApp().recipes.save(recipe.name, recipe, "global");
    const loaded = getApp().recipes.get("from-int-test");
    expect(loaded!.description).toContain("Integration test");
  });

  it("OTLP span lifecycle works end-to-end", () => {
    core.resetOtlp();
    core.configureOtlp({ enabled: true, endpoint: "http://localhost:9999/v1/traces" });

    core.emitSessionSpanStart("int-s-1", { flow: "default", repo: "/tmp" });
    core.emitStageSpanStart("int-s-1", { stage: "plan", agent: "planner", gate: "auto" });
    core.emitStageSpanEnd("int-s-1", { status: "completed" });
    core.emitSessionSpanEnd("int-s-1", { status: "completed", tokens_in: 100, cost_usd: 0.01 });

    core.resetOtlp();
  });

  it("rollback helpers produce correct output", () => {
    const payload = core.createRevertPayload({
      owner: "org",
      repo: "test",
      originalPrNumber: 99,
      originalPrTitle: "feat: thing",
      originalBranch: "feat/thing",
      failedChecks: ["CI"],
    });
    expect(payload.title).toBe("Revert: feat: thing");
    expect(payload.head).toBe("revert-feat/thing");
    expect(payload.body).toContain("#99");
  });

  it("knowledge store search returns results without errors", () => {
    getApp().knowledge.addNode({
      type: "memory",
      label: "Integration test memory for knowledge search",
      content: "Integration test memory for knowledge search",
      metadata: { tags: ["integration"], scope: "global", importance: 0.8 },
    });
    const results = getApp().knowledge.search("integration test", {
      types: ["memory"],
      limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].type).toBe("memory");
  });
});
