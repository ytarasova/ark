import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext, getApp, setApp, clearApp } from "../app.js";
import { saveRecipe, deleteRecipe, loadRecipe, listRecipes, sessionToRecipe } from "../recipe.js";
import type { RecipeDefinition } from "../../types/index.js";

let app: AppContext;
beforeEach(async () => { if (app) { await app.shutdown(); clearApp(); } app = AppContext.forTest(); setApp(app); await app.boot(); });
afterEach(async () => { if (app) { await app.shutdown(); clearApp(); } });

describe("recipe create/delete via core", () => {
  it("saveRecipe creates a global recipe and loadRecipe finds it", () => {
    saveRecipe({
      name: "test-recipe", description: "Test recipe",
      flow: "bare", variables: [{ name: "repo", description: "Repo path", required: true }],
    } as RecipeDefinition, "global");
    const recipe = loadRecipe("test-recipe");
    expect(recipe).not.toBeNull();
    expect(recipe!.name).toBe("test-recipe");
    expect(recipe!.flow).toBe("bare");
  });

  it("deleteRecipe removes a global recipe", () => {
    saveRecipe({
      name: "tmp-recipe", description: "tmp", flow: "bare", variables: [],
    } as RecipeDefinition, "global");
    expect(loadRecipe("tmp-recipe")).not.toBeNull();
    deleteRecipe("tmp-recipe", "global");
    expect(loadRecipe("tmp-recipe")).toBeNull();
  });

  it("sessionToRecipe creates recipe from session", () => {
    const session = getApp().sessions.create({ summary: "Fix auth bug", flow: "default" });
    const recipe = sessionToRecipe(session, "from-session");
    expect(recipe.name).toBe("from-session");
    expect(recipe.flow).toBe("default");
    expect(recipe.description).toContain("Fix auth bug");
  });
});
