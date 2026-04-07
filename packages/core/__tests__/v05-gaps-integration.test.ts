// packages/core/__tests__/v05-gaps-integration.test.ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import * as core from "../index.js";
import type { RecipeDefinition } from "../../types/index.js";

let app: AppContext;
beforeEach(async () => { if (app) { await app.shutdown(); clearApp(); } app = AppContext.forTest(); setApp(app); await app.boot(); });
afterEach(async () => { if (app) { await app.shutdown(); clearApp(); } });

describe("v0.5 gaps integration", () => {
  it("skill create → list → delete round-trip", () => {
    core.saveSkill({ name: "int-test", description: "Integration", prompt: "test prompt" }, "global");
    const found = core.listSkills().find(s => s.name === "int-test");
    expect(found).toBeDefined();
    expect(found!._source).toBe("global");

    core.deleteSkill("int-test", "global");
    expect(core.loadSkill("int-test")).toBeNull();
  });

  it("recipe create → list → delete round-trip", () => {
    core.saveRecipe({
      name: "int-recipe", description: "Integration recipe",
      flow: "bare", variables: [],
    } as RecipeDefinition, "global");
    const found = core.listRecipes().find(r => r.name === "int-recipe");
    expect(found).toBeDefined();

    core.deleteRecipe("int-recipe", "global");
    expect(core.loadRecipe("int-recipe")).toBeNull();
  });

  it("sessionToRecipe creates valid recipe from session", () => {
    const session = core.createSession({ summary: "Integration test", flow: "default" });
    const recipe = core.sessionToRecipe(session, "from-int-test");
    expect(recipe.name).toBe("from-int-test");
    expect(recipe.flow).toBe("default");

    core.saveRecipe(recipe, "global");
    const loaded = core.loadRecipe("from-int-test");
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
      owner: "org", repo: "test", originalPrNumber: 99,
      originalPrTitle: "feat: thing", originalBranch: "feat/thing",
      failedChecks: ["CI"],
    });
    expect(payload.title).toBe("Revert: feat: thing");
    expect(payload.head).toBe("revert-feat/thing");
    expect(payload.body).toContain("#99");
  });

  it("hybridSearch returns results without errors", async () => {
    core.remember("Integration test memory for hybrid search", {
      tags: ["integration"], scope: "global", importance: 0.8,
    });
    const results = await core.hybridSearch("integration test", {
      sources: ["memory"], rerank: false, limit: 5,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("memory");
  });
});
