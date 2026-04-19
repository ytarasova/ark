import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { sessionToRecipe } from "../agent/recipe.js";
import type { RecipeDefinition } from "../../types/index.js";

let app: AppContext;
beforeEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
  app = await AppContext.forTestAsync();
  setApp(app);
  await app.boot();
});
afterEach(async () => {
  if (app) {
    await app.shutdown();
    clearApp();
  }
});

describe("recipe create/delete via core", () => {
  it("recipes.save creates a global recipe and recipes.get finds it", () => {
    getApp().recipes.save(
      "test-recipe",
      {
        name: "test-recipe",
        description: "Test recipe",
        flow: "bare",
        variables: [{ name: "repo", description: "Repo path", required: true }],
      } as RecipeDefinition,
      "global",
    );
    const recipe = getApp().recipes.get("test-recipe");
    expect(recipe).not.toBeNull();
    expect(recipe!.name).toBe("test-recipe");
    expect(recipe!.flow).toBe("bare");
  });

  it("recipes.delete removes a global recipe", () => {
    getApp().recipes.save(
      "tmp-recipe",
      {
        name: "tmp-recipe",
        description: "tmp",
        flow: "bare",
        variables: [],
      } as RecipeDefinition,
      "global",
    );
    expect(getApp().recipes.get("tmp-recipe")).not.toBeNull();
    getApp().recipes.delete("tmp-recipe", "global");
    expect(getApp().recipes.get("tmp-recipe")).toBeNull();
  });

  it("sessionToRecipe creates recipe from session", () => {
    const session = getApp().sessions.create({ summary: "Fix auth bug", flow: "default" });
    const recipe = sessionToRecipe(session, "from-session");
    expect(recipe.name).toBe("from-session");
    expect(recipe.flow).toBe("default");
    expect(recipe.description).toContain("Fix auth bug");
  });
});
