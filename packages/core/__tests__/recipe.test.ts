/**
 * Tests for recipe.ts — CRUD, variable instantiation.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { listRecipes, loadRecipe, instantiateRecipe } from "../recipe.js";

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
});
