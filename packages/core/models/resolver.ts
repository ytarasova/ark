/**
 * Model catalog resolver.
 *
 * Pure helpers that turn a model id / alias into a concrete provider slug.
 * The three-layer lookup (project > global > bundled) lives in
 * `packages/core/stores/model-store.ts`; this module stays free of AppContext
 * so it can be used by any caller that already holds either a `ModelStore` or
 * a pre-built catalog `Map`.
 *
 * `loadModels` remains exported for tests + the store's builtin-layer loader.
 * It builds a single-directory catalog keyed by id AND by each alias. Callers
 * with multi-layer needs should use a `FileModelStore` instead.
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { ModelDefinition } from "../../types/model.js";
import type { ModelStore } from "../stores/model-store.js";

export type { ModelDefinition, ModelPricing } from "../../types/model.js";

function normaliseKey(s: string): string {
  return s.toLowerCase();
}

/**
 * Load every `*.yaml` file under `dir` and return a map keyed by canonical id
 * and by each alias. Throws if two models share an id or alias (no silent
 * collisions -- the catalog must be unambiguous). Used by tests + the
 * ModelStore's builtin-layer loader; for production lookups prefer the
 * three-layer `ModelStore.get()`.
 */
export function loadModels(dir: string): Map<string, ModelDefinition> {
  const catalog = new Map<string, ModelDefinition>();
  const byId = new Map<string, ModelDefinition>();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: any) {
    throw new Error(`loadModels: cannot read directory "${dir}": ${err?.message ?? err}`);
  }

  const files = entries.filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  for (const file of files) {
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = YAML.parse(readFileSync(path, "utf-8"));
    } catch (err: any) {
      throw new Error(`loadModels: failed to parse "${path}": ${err?.message ?? err}`);
    }
    if (!raw || typeof raw !== "object") {
      throw new Error(`loadModels: "${path}" is not a YAML object`);
    }
    const model = raw as ModelDefinition;
    if (!model.id || typeof model.id !== "string") {
      throw new Error(`loadModels: "${path}" is missing required field "id"`);
    }
    if (!model.provider || typeof model.provider !== "string") {
      throw new Error(`loadModels: model "${model.id}" is missing required field "provider"`);
    }
    if (!model.provider_slugs || typeof model.provider_slugs !== "object") {
      throw new Error(`loadModels: model "${model.id}" is missing required field "provider_slugs"`);
    }

    const idKey = normaliseKey(model.id);
    if (byId.has(idKey)) {
      throw new Error(`loadModels: duplicate model id "${model.id}" (already defined by another file)`);
    }
    byId.set(idKey, model);

    if (catalog.has(idKey)) {
      throw new Error(`loadModels: id "${model.id}" collides with an existing alias in the catalog`);
    }
    catalog.set(idKey, model);

    for (const alias of model.aliases ?? []) {
      const aliasKey = normaliseKey(alias);
      if (catalog.has(aliasKey)) {
        const prior = catalog.get(aliasKey)!;
        throw new Error(
          `loadModels: alias "${alias}" on model "${model.id}" collides with existing entry "${prior.id}"`,
        );
      }
      catalog.set(aliasKey, model);
    }
  }

  return catalog;
}

/**
 * Resolve a canonical id OR alias against a pre-built catalog Map.
 * Throws with a caller-friendly error listing the available canonical ids
 * when the lookup misses.
 */
export function resolveModel(catalog: Map<string, ModelDefinition>, idOrAlias: string): ModelDefinition {
  const hit = catalog.get(normaliseKey(idOrAlias));
  if (hit) return hit;

  // List canonical ids only (not aliases) -- the catalog map mixes both.
  const ids = new Set<string>();
  for (const m of catalog.values()) ids.add(m.id);
  const sorted = Array.from(ids).sort();
  throw new Error(`Model "${idOrAlias}" not found in catalog. Available: [${sorted.join(", ")}]`);
}

/**
 * Resolve a model id/alias via a `ModelStore`. Convenience wrapper used by
 * `resolve-stage.ts` so callers on the hot path can skip the catalog-map
 * plumbing and just call the store directly.
 */
export function resolveModelFromStore(store: ModelStore, idOrAlias: string, projectRoot?: string): ModelDefinition {
  const hit = store.get(idOrAlias, projectRoot);
  if (hit) return hit;
  const ids = store
    .list(projectRoot)
    .map((m) => m.id)
    .sort();
  throw new Error(`Model "${idOrAlias}" not found in catalog. Available: [${ids.join(", ")}]`);
}

/**
 * Return the concrete slug a given provider/access-path expects for this
 * model. Throws if the model does not declare a slug for that provider.
 */
export function providerSlugFor(model: ModelDefinition, providerKey: string): string {
  const slug = model.provider_slugs?.[providerKey];
  if (!slug) {
    throw new Error(`Model "${model.id}" has no slug for provider "${providerKey}"`);
  }
  return slug;
}
