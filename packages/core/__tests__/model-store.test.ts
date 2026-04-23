/**
 * Tests for the three-layer FileModelStore.
 *
 * Verifies that project > global > bundled precedence is honored wholesale:
 * a later-layer definition replaces an earlier one entirely (no deep-merge).
 * Also exercises cross-layer alias collision -- a model in the project layer
 * that aliases a bundled id should shadow the bundled entry.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import YAML from "yaml";

import { FileModelStore } from "../stores/model-store.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ark-model-store-"));
}

function writeModel(dir: string, file: string, data: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), YAML.stringify(data));
}

describe("FileModelStore: three-layer lookup", () => {
  let bundled: string;
  let global: string;
  let projectRoot: string;

  beforeEach(() => {
    bundled = join(tempDir(), "models");
    const globalBase = tempDir();
    global = join(globalBase, "models");
    projectRoot = tempDir();
  });

  it("falls back to the bundled layer when nothing overrides", () => {
    writeModel(bundled, "foo.yaml", {
      id: "foo",
      display: "Foo",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "foo-direct" },
    });
    const store = new FileModelStore({ builtinDir: bundled, userDir: global });
    const hit = store.get("foo");
    expect(hit?.id).toBe("foo");
    expect(hit?._source).toBe("builtin");
  });

  it("global layer replaces a bundled definition by id", () => {
    writeModel(bundled, "foo.yaml", {
      id: "foo",
      display: "Foo (bundled)",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "foo-bundled" },
    });
    writeModel(global, "foo.yaml", {
      id: "foo",
      display: "Foo (global)",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "foo-global" },
    });
    const store = new FileModelStore({ builtinDir: bundled, userDir: global });
    const hit = store.get("foo");
    expect(hit?.display).toBe("Foo (global)");
    expect(hit?._source).toBe("global");
    expect(hit?.provider_slugs["anthropic-direct"]).toBe("foo-global");
  });

  it("project layer wins over global and bundled", () => {
    writeModel(bundled, "foo.yaml", {
      id: "foo",
      display: "Foo (bundled)",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "foo-bundled" },
    });
    writeModel(global, "foo.yaml", {
      id: "foo",
      display: "Foo (global)",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "foo-global" },
    });
    writeModel(join(projectRoot, ".ark", "models"), "foo.yaml", {
      id: "foo",
      display: "Foo (project)",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "foo-project" },
    });
    const store = new FileModelStore({ builtinDir: bundled, userDir: global });
    const hit = store.get("foo", projectRoot);
    expect(hit?.display).toBe("Foo (project)");
    expect(hit?._source).toBe("project");
  });

  it("replaces wholesale -- no field-level deep-merge", () => {
    // Bundled entry declares two provider slugs; global entry declares only
    // one. Project-less lookup should see only the global slugs -- the
    // bundled slug must NOT leak through.
    writeModel(bundled, "foo.yaml", {
      id: "foo",
      display: "Foo",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "a", "tf-bedrock": "b" },
    });
    writeModel(global, "foo.yaml", {
      id: "foo",
      display: "Foo",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "a-override" },
    });
    const store = new FileModelStore({ builtinDir: bundled, userDir: global });
    const hit = store.get("foo");
    expect(Object.keys(hit!.provider_slugs).sort()).toEqual(["anthropic-direct"]);
    expect(hit!.provider_slugs["anthropic-direct"]).toBe("a-override");
  });

  it("project-layer alias shadows a bundled entry with that id", () => {
    writeModel(bundled, "fast.yaml", {
      id: "fast",
      display: "Fast (bundled)",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "fast-bundled" },
    });
    writeModel(join(projectRoot, ".ark", "models"), "turbo.yaml", {
      id: "turbo",
      display: "Turbo (project)",
      provider: "anthropic",
      aliases: ["fast"],
      provider_slugs: { "anthropic-direct": "turbo-project" },
    });
    const store = new FileModelStore({ builtinDir: bundled, userDir: global });
    // Looking up "fast" now lands on the project "turbo" entry because its
    // alias overrides the bundled id.
    const hit = store.get("fast", projectRoot);
    expect(hit?.id).toBe("turbo");
    expect(hit?._source).toBe("project");
  });

  it("list returns one entry per canonical id across all layers", () => {
    writeModel(bundled, "a.yaml", {
      id: "a",
      display: "A",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "a1" },
    });
    writeModel(bundled, "b.yaml", {
      id: "b",
      display: "B",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "b1" },
    });
    writeModel(global, "a.yaml", {
      id: "a",
      display: "A (global)",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "a1-global" },
    });
    const store = new FileModelStore({ builtinDir: bundled, userDir: global });
    const listed = store.list();
    const ids = listed.map((m) => m.id).sort();
    expect(ids).toEqual(["a", "b"]);
    // Global wins.
    expect(listed.find((m) => m.id === "a")?.display).toBe("A (global)");
  });

  it("returns null for an unknown id", () => {
    writeModel(bundled, "x.yaml", {
      id: "x",
      display: "X",
      provider: "anthropic",
      provider_slugs: { "anthropic-direct": "x1" },
    });
    const store = new FileModelStore({ builtinDir: bundled, userDir: global });
    expect(store.get("nope")).toBeNull();
  });
});
