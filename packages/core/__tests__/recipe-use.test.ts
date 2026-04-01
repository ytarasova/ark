/**
 * Tests for recipe "use" — creating sessions from recipes.
 */

import { describe, it, expect } from "bun:test";
import { withTestContext } from "./test-helpers.js";
import { loadRecipe, instantiateRecipe } from "../recipe.js";
import { startSession } from "../session.js";
import * as store from "../store.js";

const { getCtx } = withTestContext();

describe("recipe use", () => {
  it("creates a session from a recipe with defaults", () => {
    const recipe = loadRecipe("quick-fix")!;
    expect(recipe).not.toBeNull();

    const instance = instantiateRecipe(recipe, { repo: "/tmp/test", summary: "test fix" });
    const session = startSession({
      summary: instance.summary ?? recipe.description,
      repo: instance.repo,
      flow: instance.flow,
      compute_name: instance.compute,
      group_name: instance.group,
    });

    expect(session.id).toBeDefined();
    expect(session.summary).toBe("test fix");
    expect(session.repo).toBe("/tmp/test");
    expect(session.flow).toBe(recipe.flow);
  });

  it("creates a session with overridden values", () => {
    const recipe = loadRecipe("code-review")!;
    expect(recipe).not.toBeNull();

    const instance = instantiateRecipe(recipe, { repo: "/tmp/myrepo", summary: "Custom review task" });
    const session = startSession({
      summary: instance.summary ?? recipe.description,
      repo: instance.repo,
      flow: instance.flow,
      compute_name: instance.compute,
      group_name: instance.group,
    });

    expect(session.summary).toBe("Custom review task");
    expect(session.repo).toBe("/tmp/myrepo");
  });

  it("falls back to recipe description when no summary provided", () => {
    const recipe = loadRecipe("quick-fix")!;
    const instance = instantiateRecipe(recipe, { repo: "/tmp/test" });
    const session = startSession({
      summary: instance.summary ?? recipe.description,
      repo: instance.repo,
      flow: instance.flow,
    });

    expect(session.summary).toBe(recipe.description);
  });
});
