/**
 * Tests for FileRecipeStore - list, get, save, delete with three-tier resolution.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { stringify as stringifyYaml } from "yaml";
import { FileRecipeStore } from "../../stores/recipe-store.js";

let store: FileRecipeStore;
let builtinDir: string;
let userDir: string;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ark-recipe-store-test-"));
  builtinDir = join(tempDir, "builtin");
  userDir = join(tempDir, "user");
  mkdirSync(builtinDir, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  store = new FileRecipeStore({ builtinDir, userDir });
});

function writeRecipe(dir: string, name: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, `${name}.yaml`), stringifyYaml(data));
}

// ── get ─────────────────────────────────────────────────────────────────────

describe("FileRecipeStore.get", () => {
  it("returns null for non-existent recipe", () => {
    expect(store.get("does-not-exist")).toBeNull();
  });

  it("loads a recipe from builtin dir", () => {
    writeRecipe(builtinDir, "test-recipe", {
      name: "test-recipe",
      description: "A test recipe",
      flow: "bare",
      variables: [],
    });
    const recipe = store.get("test-recipe");
    expect(recipe).not.toBeNull();
    expect(recipe!.name).toBe("test-recipe");
    expect(recipe!.flow).toBe("bare");
    expect(recipe!._source).toBe("builtin");
  });

  it("user dir overrides builtin dir", () => {
    writeRecipe(builtinDir, "shared", { name: "shared", description: "builtin", flow: "default", variables: [] });
    writeRecipe(userDir, "shared", { name: "shared", description: "global", flow: "quick", variables: [] });
    const recipe = store.get("shared");
    expect(recipe!._source).toBe("global");
    expect(recipe!.description).toBe("global");
    expect(recipe!.flow).toBe("quick");
  });

  it("project dir overrides both when projectRoot is passed", () => {
    const projRoot = join(tempDir, "project-root");
    const projRecipeDir = join(projRoot, ".ark", "recipes");
    mkdirSync(projRecipeDir, { recursive: true });
    writeRecipe(builtinDir, "shared", { name: "shared", description: "builtin", flow: "default", variables: [] });
    writeRecipe(userDir, "shared", { name: "shared", description: "global", flow: "quick", variables: [] });
    writeRecipe(projRecipeDir, "shared", { name: "shared", description: "project", flow: "bare", variables: [] });

    const recipe = store.get("shared", projRoot);
    expect(recipe!._source).toBe("project");
    expect(recipe!.description).toBe("project");
  });
});

// ── list ────────────────────────────────────────────────────────────────────

describe("FileRecipeStore.list", () => {
  it("returns empty when no recipes exist", () => {
    expect(store.list()).toEqual([]);
  });

  it("lists recipes from builtin and user dirs", () => {
    writeRecipe(builtinDir, "b-recipe", { name: "b-recipe", flow: "default", variables: [] });
    writeRecipe(userDir, "u-recipe", { name: "u-recipe", flow: "quick", variables: [] });
    const recipes = store.list();
    const names = recipes.map((r) => r.name);
    expect(names).toContain("b-recipe");
    expect(names).toContain("u-recipe");
  });

  it("results are sorted by name", () => {
    writeRecipe(builtinDir, "zebra", { name: "zebra", flow: "default", variables: [] });
    writeRecipe(builtinDir, "alpha", { name: "alpha", flow: "default", variables: [] });
    const recipes = store.list();
    expect(recipes[0].name).toBe("alpha");
    expect(recipes[1].name).toBe("zebra");
  });

  it("user recipe overrides builtin with same name", () => {
    writeRecipe(builtinDir, "overlap", { name: "overlap", description: "builtin", flow: "default", variables: [] });
    writeRecipe(userDir, "overlap", { name: "overlap", description: "global", flow: "quick", variables: [] });
    const recipes = store.list();
    const overlap = recipes.filter((r) => r.name === "overlap");
    expect(overlap).toHaveLength(1);
    expect(overlap[0]._source).toBe("global");
  });

  it("ensures variables defaults to empty array", () => {
    writeRecipe(builtinDir, "no-vars", { name: "no-vars", flow: "default" });
    const recipes = store.list();
    const noVars = recipes.find((r) => r.name === "no-vars");
    expect(noVars!.variables).toEqual([]);
  });
});

// ── save ────────────────────────────────────────────────────────────────────

describe("FileRecipeStore.save", () => {
  it("saves to user dir by default", () => {
    store.save("new-recipe", { name: "new-recipe", description: "test", flow: "bare", variables: [] } as any);
    expect(existsSync(join(userDir, "new-recipe.yaml"))).toBe(true);
    const loaded = store.get("new-recipe");
    expect(loaded!.name).toBe("new-recipe");
  });

  it("saves to project dir when scope is project", () => {
    const projRoot = join(tempDir, "proj-save");
    store.save("proj-recipe", { name: "proj-recipe", flow: "bare", variables: [] } as any, "project", projRoot);
    expect(existsSync(join(projRoot, ".ark", "recipes", "proj-recipe.yaml"))).toBe(true);
  });

  it("strips _source from saved YAML", () => {
    store.save("stripped", { name: "stripped", flow: "bare", variables: [], _source: "global" } as any);
    const loaded = store.get("stripped");
    expect(loaded!.name).toBe("stripped");
  });
});

// ── delete ──────────────────────────────────────────────────────────────────

describe("FileRecipeStore.delete", () => {
  it("returns false for non-existent recipe", () => {
    expect(store.delete("ghost")).toBe(false);
  });

  it("deletes from user dir and returns true", () => {
    writeRecipe(userDir, "to-del", { name: "to-del", flow: "default", variables: [] });
    expect(store.delete("to-del")).toBe(true);
    expect(existsSync(join(userDir, "to-del.yaml"))).toBe(false);
  });

  it("deletes .yml files too", () => {
    writeFileSync(
      join(userDir, "yml-recipe.yml"),
      stringifyYaml({ name: "yml-recipe", flow: "default", variables: [] }),
    );
    expect(store.delete("yml-recipe")).toBe(true);
    expect(existsSync(join(userDir, "yml-recipe.yml"))).toBe(false);
  });

  it("deletes from project dir when scope is project", () => {
    const projRoot = join(tempDir, "proj-del");
    const projRecipeDir = join(projRoot, ".ark", "recipes");
    mkdirSync(projRecipeDir, { recursive: true });
    writeRecipe(projRecipeDir, "p-del", { name: "p-del", flow: "default", variables: [] });

    expect(store.delete("p-del", "project", projRoot)).toBe(true);
    expect(existsSync(join(projRecipeDir, "p-del.yaml"))).toBe(false);
  });
});
