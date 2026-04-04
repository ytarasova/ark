import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, setContext, type TestContext } from "../context.js";
import { saveRecipe, deleteRecipe, loadRecipe, listRecipes, sessionToRecipe } from "../recipe.js";
import { createSession } from "../store.js";

let ctx: TestContext;
beforeEach(() => { ctx = createTestContext(); setContext(ctx); });
afterEach(() => { ctx.cleanup(); });

describe("recipe create/delete via core", () => {
  it("saveRecipe creates a global recipe and loadRecipe finds it", () => {
    saveRecipe({
      name: "test-recipe", description: "Test recipe",
      flow: "bare", variables: [{ name: "repo", description: "Repo path", required: true }],
    } as any, "global");
    const recipe = loadRecipe("test-recipe");
    expect(recipe).not.toBeNull();
    expect(recipe!.name).toBe("test-recipe");
    expect(recipe!.flow).toBe("bare");
  });

  it("deleteRecipe removes a global recipe", () => {
    saveRecipe({
      name: "tmp-recipe", description: "tmp", flow: "bare", variables: [],
    } as any, "global");
    expect(loadRecipe("tmp-recipe")).not.toBeNull();
    deleteRecipe("tmp-recipe", "global");
    expect(loadRecipe("tmp-recipe")).toBeNull();
  });

  it("sessionToRecipe creates recipe from session", () => {
    const session = createSession({ summary: "Fix auth bug", flow: "default" });
    const recipe = sessionToRecipe(session, "from-session");
    expect(recipe.name).toBe("from-session");
    expect(recipe.flow).toBe("default");
    expect(recipe.description).toContain("Fix auth bug");
  });
});
