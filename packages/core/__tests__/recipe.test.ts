/**
 * Tests for recipe.ts — CRUD, variable instantiation.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { listRecipes, loadRecipe, instantiateRecipe, saveRecipe, deleteRecipe, sessionToRecipe } from "../recipe.js";
import { getApp } from "../app.js";

const { getCtx } = withTestContext();

describe("recipe CRUD", () => {
  it("listRecipes returns builtin recipes", () => {
    const recipes = listRecipes();
    expect(recipes.length).toBeGreaterThan(0);
    expect(recipes.some(r => r.name === "quick-fix")).toBe(true);
  });

  it("loadRecipe returns a recipe by name", () => {
    const recipe = loadRecipe("quick-fix");
    expect(recipe).not.toBeNull();
    expect(recipe!.flow).toBeDefined();
    expect(recipe!.variables).toBeDefined();
  });

  it("instantiateRecipe fills variables into flow config", () => {
    const recipe = loadRecipe("quick-fix")!;
    const result = instantiateRecipe(recipe, { repo: "/tmp/test", summary: "Fix bug" });
    expect(result.repo).toBe("/tmp/test");
    expect(result.summary).toBe("Fix bug");
    expect(result.flow).toBeDefined();
  });

  it("loadRecipe returns null for unknown recipe", () => {
    expect(loadRecipe("nonexistent")).toBeNull();
  });

  it("instantiateRecipe uses defaults when values not provided", () => {
    const recipe = loadRecipe("code-review")!;
    const result = instantiateRecipe(recipe, { repo: "/tmp/test" });
    expect(result.repo).toBe("/tmp/test");
    expect(result.summary).toBe("Review the code changes on this branch");
    expect(result.flow).toBe("bare");
    expect(result.agent).toBe("reviewer");
  });

  it("instantiateRecipe values override defaults", () => {
    const recipe = loadRecipe("code-review")!;
    const result = instantiateRecipe(recipe, { repo: "/tmp/test", summary: "Custom review" });
    expect(result.summary).toBe("Custom review");
  });

  it("saveRecipe and deleteRecipe round-trip", () => {
    saveRecipe({
      name: "test-recipe",
      description: "test",
      flow: "bare",
      repo: "/tmp/my-repo",
      variables: [],
    }, "global");
    const loaded = loadRecipe("test-recipe");
    expect(loaded).not.toBeNull();
    expect(loaded!.repo).toBe("/tmp/my-repo");
    expect(loaded!._source).toBe("global");

    deleteRecipe("test-recipe", "global");
    expect(loadRecipe("test-recipe")).toBeNull();
  });

  it("instantiateRecipe uses recipe repo when set", () => {
    const recipe = {
      name: "with-repo",
      description: "has repo",
      repo: "/projects/ark",
      flow: "bare",
      variables: [],
    };
    const result = instantiateRecipe(recipe, { summary: "do stuff" });
    expect(result.repo).toBe("/projects/ark");
  });

  it("sessionToRecipe captures session config", () => {
    const s = getApp().sessions.create({
      summary: "Fix auth bug",
      repo: "/projects/myapp",
      flow: "default",
    });
    getApp().sessions.update(s.id, { agent: "implementer", compute_name: "local", group_name: "bugs" });
    const updated = getApp().sessions.get(s.id)!;

    const recipe = sessionToRecipe(updated, "fix-auth");
    expect(recipe.name).toBe("fix-auth");
    expect(recipe.repo).toBe("/projects/myapp");
    expect(recipe.flow).toBe("default");
    expect(recipe.agent).toBe("implementer");
    expect(recipe.compute).toBe("local");
    expect(recipe.group).toBe("bugs");
    expect(recipe.defaults?.summary).toBe("Fix auth bug");
  });
});
