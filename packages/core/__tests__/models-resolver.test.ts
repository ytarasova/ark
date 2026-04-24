/**
 * Tests for the model catalog resolver.
 *
 * Covers loading the real `models/` directory at the repo root plus a set of
 * synthetic fixture dirs (via mkdtempSync) that exercise the error paths
 * (missing id, duplicate id, alias/id collision, missing provider slug).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import YAML from "yaml";

import { AppContext } from "../app.js";
import { loadModels, resolveModel, providerSlugFor } from "../models/index.js";
import type { ModelDefinition } from "../models/index.js";

let app: AppContext;
let realCatalog: Map<string, ModelDefinition>;
const REAL_MODELS_DIR = join(import.meta.dir, "..", "..", "..", "models");

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  realCatalog = loadModels(REAL_MODELS_DIR);
});

afterAll(async () => {
  await app?.shutdown();
});

function writeModel(dir: string, file: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, file), YAML.stringify(data));
}

function tempModelsDir(): string {
  return mkdtempSync(join(tmpdir(), "ark-models-test-"));
}

// ── loadModels + real catalog ───────────────────────────────────────────────

describe("loadModels: real models/ directory", () => {
  it("loads every catalog entry", () => {
    const ids = new Set<string>();
    for (const m of realCatalog.values()) ids.add(m.id);
    // The catalog has 11 models today; assert >= 11 so adding future models
    // does not break this test.
    expect(ids.size).toBeGreaterThanOrEqual(11);
  });

  it("indexes models by canonical id", () => {
    expect(resolveModel(realCatalog, "claude-sonnet-4-6").id).toBe("claude-sonnet-4-6");
    expect(resolveModel(realCatalog, "claude-opus-4-7").id).toBe("claude-opus-4-7");
    expect(resolveModel(realCatalog, "gemini-2-5-pro").id).toBe("gemini-2-5-pro");
  });

  it("indexes models by alias", () => {
    expect(resolveModel(realCatalog, "sonnet").id).toBe("claude-sonnet-4-6");
    expect(resolveModel(realCatalog, "opus").id).toBe("claude-opus-4-7");
    expect(resolveModel(realCatalog, "haiku").id).toBe("claude-haiku-4-5");
    expect(resolveModel(realCatalog, "gemini-pro").id).toBe("gemini-2-5-pro");
  });

  it("lookup is case-insensitive", () => {
    expect(resolveModel(realCatalog, "SONNET").id).toBe("claude-sonnet-4-6");
    expect(resolveModel(realCatalog, "Claude-Opus-Latest").id).toBe("claude-opus-4-7");
  });
});

// ── resolveModel: error path ────────────────────────────────────────────────

describe("resolveModel: unknown id", () => {
  it("throws a clean error listing available ids", () => {
    try {
      resolveModel(realCatalog, "not-a-real-model");
      throw new Error("expected resolveModel to throw");
    } catch (err: any) {
      expect(err.message).toContain('Model "not-a-real-model" not found in catalog');
      expect(err.message).toContain("Available: [");
      expect(err.message).toContain("claude-sonnet-4-6");
      // Aliases should NOT appear in the available list.
      expect(err.message).not.toContain("sonnet,");
    }
  });
});

// ── providerSlugFor ─────────────────────────────────────────────────────────

describe("providerSlugFor", () => {
  it("returns the slug registered for that provider", () => {
    const sonnet = resolveModel(realCatalog, "sonnet");
    expect(providerSlugFor(sonnet, "anthropic-direct")).toBe("claude-sonnet-4-6");
    expect(providerSlugFor(sonnet, "tf-bedrock")).toBe("pi-agentic/global.anthropic.claude-sonnet-4-6");
  });

  it("throws when the provider is not declared for this model", () => {
    const sonnet = resolveModel(realCatalog, "sonnet");
    try {
      providerSlugFor(sonnet, "openai-direct");
      throw new Error("expected providerSlugFor to throw");
    } catch (err: any) {
      expect(err.message).toContain('Model "claude-sonnet-4-6" has no slug for provider "openai-direct"');
    }
  });
});

// ── loadModels: fixture-driven error paths ──────────────────────────────────

describe("loadModels: fixture errors", () => {
  it("throws on duplicate id across two files", () => {
    const dir = tempModelsDir();
    writeModel(dir, "a.yaml", {
      id: "dup",
      display: "A",
      provider: "x",
      provider_slugs: { p: "a" },
    });
    writeModel(dir, "b.yaml", {
      id: "dup",
      display: "B",
      provider: "x",
      provider_slugs: { p: "b" },
    });
    try {
      loadModels(dir);
      throw new Error("expected loadModels to throw");
    } catch (err: any) {
      expect(err.message).toContain('duplicate model id "dup"');
    }
  });

  it("throws on alias that collides with another model's id", () => {
    const dir = tempModelsDir();
    writeModel(dir, "a.yaml", {
      id: "real-id",
      display: "A",
      provider: "x",
      provider_slugs: { p: "a" },
    });
    writeModel(dir, "b.yaml", {
      id: "other",
      display: "B",
      provider: "x",
      aliases: ["real-id"],
      provider_slugs: { p: "b" },
    });
    try {
      loadModels(dir);
      throw new Error("expected loadModels to throw");
    } catch (err: any) {
      expect(err.message).toContain('alias "real-id"');
      expect(err.message).toContain("collides");
    }
  });

  it("throws on alias collision across two models", () => {
    const dir = tempModelsDir();
    writeModel(dir, "a.yaml", {
      id: "a",
      display: "A",
      provider: "x",
      aliases: ["shared-alias"],
      provider_slugs: { p: "a" },
    });
    writeModel(dir, "b.yaml", {
      id: "b",
      display: "B",
      provider: "x",
      aliases: ["shared-alias"],
      provider_slugs: { p: "b" },
    });
    try {
      loadModels(dir);
      throw new Error("expected loadModels to throw");
    } catch (err: any) {
      expect(err.message).toContain('alias "shared-alias"');
      expect(err.message).toContain("collides");
    }
  });

  it("throws when id is missing", () => {
    const dir = tempModelsDir();
    writeModel(dir, "a.yaml", {
      display: "A",
      provider: "x",
      provider_slugs: { p: "a" },
    });
    try {
      loadModels(dir);
      throw new Error("expected loadModels to throw");
    } catch (err: any) {
      expect(err.message).toContain('missing required field "id"');
    }
  });

  it("throws when provider_slugs is missing", () => {
    const dir = tempModelsDir();
    writeModel(dir, "a.yaml", {
      id: "foo",
      display: "Foo",
      provider: "x",
    });
    try {
      loadModels(dir);
      throw new Error("expected loadModels to throw");
    } catch (err: any) {
      expect(err.message).toContain('missing required field "provider_slugs"');
    }
  });

  it("ignores non-yaml files in the directory", () => {
    const dir = tempModelsDir();
    writeModel(dir, "a.yaml", {
      id: "only",
      display: "Only",
      provider: "x",
      provider_slugs: { p: "s" },
    });
    writeFileSync(join(dir, "README.md"), "# not a model");
    writeFileSync(join(dir, "notes.txt"), "ignored");
    mkdirSync(join(dir, "subdir"));
    const catalog = loadModels(dir);
    expect(resolveModel(catalog, "only").id).toBe("only");
  });
});
