/**
 * ModelStore -- three-tier file-backed lookup for model catalog entries.
 *
 * Precedence: project (`<projectRoot>/.ark/models/`) > global (`<arkDir>/models/`)
 * > bundled (`<ark install dir>/models/`). A later-layer definition replaces an
 * earlier one wholesale; fields are NOT deep-merged.
 *
 * Lookup is keyed by canonical id AND by each alias (case-insensitive). The
 * store exposes `list()` for enumeration and `get(idOrAlias, projectRoot?)`
 * for the hot dispatch path. The three-layer catalog is rebuilt on first
 * access and cached for the store's lifetime.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import YAML from "yaml";
import type { ModelDefinition } from "../../types/model.js";

// ── Interface ───────────────────────────────────────────────────────────────

export interface ModelStore {
  list(projectRoot?: string): ModelDefinition[];
  get(idOrAlias: string, projectRoot?: string): ModelDefinition | null;
  /**
   * The canonical default model for boot-time seeding. Resolves the alias
   * "sonnet" against the catalog so operators can swap the default by
   * pointing a project / global YAML at a different entry with that
   * alias. Throws if the catalog has no "sonnet" alias -- a fresh install
   * with no model catalog is a broken install.
   */
  default(projectRoot?: string): ModelDefinition;
}

/** Alias used by `default()`. Hosted agent-store seeding calls this. */
export const DEFAULT_MODEL_ALIAS = "sonnet";

// ── File-backed implementation ──────────────────────────────────────────────

export interface FileModelStoreOpts {
  /** Directory holding the bundled model catalog shipped in the tarball. */
  builtinDir: string;
  /** Global per-user override directory (typically `~/.ark/models/`). */
  userDir: string;
  /** Optional static project directory override. */
  projectDir?: string;
}

type Source = "builtin" | "global" | "project";

function normaliseKey(s: string): string {
  return s.toLowerCase();
}

function readLayer(dir: string, source: Source): ModelDefinition[] {
  if (!existsSync(dir)) return [];
  const out: ModelDefinition[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!(file.endsWith(".yaml") || file.endsWith(".yml"))) continue;
    const path = join(dir, file);
    let raw: unknown;
    try {
      raw = YAML.parse(readFileSync(path, "utf-8"));
    } catch (err: any) {
      throw new Error(`ModelStore: failed to parse "${path}": ${err?.message ?? err}`);
    }
    if (!raw || typeof raw !== "object") {
      throw new Error(`ModelStore: "${path}" is not a YAML object`);
    }
    const model = raw as ModelDefinition & { _source?: Source; _path?: string };
    if (!model.id || typeof model.id !== "string") {
      throw new Error(`ModelStore: "${path}" is missing required field "id"`);
    }
    if (!model.provider || typeof model.provider !== "string") {
      throw new Error(`ModelStore: model "${model.id}" is missing required field "provider"`);
    }
    if (!model.provider_slugs || typeof model.provider_slugs !== "object") {
      throw new Error(`ModelStore: model "${model.id}" is missing required field "provider_slugs"`);
    }
    model._source = source;
    model._path = path;
    out.push(model);
  }
  return out;
}

/**
 * Merge a list of layers (lowest precedence first) into a canonical catalog.
 * A later-layer model with the same id or the same alias as an earlier-layer
 * one replaces the earlier entry entirely. Duplicates inside a single layer
 * throw (configuration error: an author must pick one file).
 */
function buildCatalog(layers: Array<[ModelDefinition[], Source]>): {
  byId: Map<string, ModelDefinition>;
  byKey: Map<string, ModelDefinition>;
} {
  const byId = new Map<string, ModelDefinition>();
  const byKey = new Map<string, ModelDefinition>();

  for (const [layer, _source] of layers) {
    // Intra-layer duplicate check
    const seenIds = new Set<string>();
    const seenAliases = new Map<string, string>(); // alias -> owning id
    for (const model of layer) {
      const idKey = normaliseKey(model.id);
      if (seenIds.has(idKey)) {
        throw new Error(`ModelStore: duplicate id "${model.id}" within layer "${model._source}"`);
      }
      seenIds.add(idKey);
      for (const alias of model.aliases ?? []) {
        const aliasKey = normaliseKey(alias);
        const prior = seenAliases.get(aliasKey);
        if (prior && prior !== model.id) {
          throw new Error(
            `ModelStore: alias "${alias}" on "${model.id}" collides with "${prior}" in layer "${model._source}"`,
          );
        }
        seenAliases.set(aliasKey, model.id);
      }
    }

    // Apply this layer on top of everything we already have. A model replaces
    // any prior entry that shares its id OR any of its aliases.
    for (const model of layer) {
      const idKey = normaliseKey(model.id);
      const keysToReplace = new Set<string>([idKey]);
      for (const alias of model.aliases ?? []) keysToReplace.add(normaliseKey(alias));

      // Drop every prior entry that owned any of these keys.
      const dropIds = new Set<string>();
      for (const key of keysToReplace) {
        const prior = byKey.get(key);
        if (prior) dropIds.add(normaliseKey(prior.id));
      }
      for (const dropId of dropIds) {
        const prior = byId.get(dropId);
        if (!prior) continue;
        byId.delete(dropId);
        byKey.delete(dropId);
        for (const alias of prior.aliases ?? []) byKey.delete(normaliseKey(alias));
      }

      byId.set(idKey, model);
      byKey.set(idKey, model);
      for (const alias of model.aliases ?? []) byKey.set(normaliseKey(alias), model);
    }
  }

  return { byId, byKey };
}

export class FileModelStore implements ModelStore {
  private builtinDir: string;
  private userDir: string;
  private projectDir?: string;
  /** Cache keyed by `projectRoot ?? ""`. */
  private cache = new Map<string, { byId: Map<string, ModelDefinition>; byKey: Map<string, ModelDefinition> }>();

  constructor(opts: FileModelStoreOpts) {
    this.builtinDir = opts.builtinDir;
    this.userDir = opts.userDir;
    this.projectDir = opts.projectDir;
  }

  private catalog(projectRoot?: string): { byId: Map<string, ModelDefinition>; byKey: Map<string, ModelDefinition> } {
    const key = projectRoot ?? this.projectDir ?? "";
    const hit = this.cache.get(key);
    if (hit) return hit;

    const layers: Array<[ModelDefinition[], Source]> = [
      [readLayer(this.builtinDir, "builtin"), "builtin"],
      [readLayer(this.userDir, "global"), "global"],
    ];
    const projDir = projectRoot ? join(projectRoot, ".ark", "models") : this.projectDir;
    if (projDir) layers.push([readLayer(projDir, "project"), "project"]);

    const catalog = buildCatalog(layers);
    this.cache.set(key, catalog);
    return catalog;
  }

  get(idOrAlias: string, projectRoot?: string): ModelDefinition | null {
    return this.catalog(projectRoot).byKey.get(normaliseKey(idOrAlias)) ?? null;
  }

  list(projectRoot?: string): ModelDefinition[] {
    return Array.from(this.catalog(projectRoot).byId.values());
  }

  default(projectRoot?: string): ModelDefinition {
    const hit = this.get(DEFAULT_MODEL_ALIAS, projectRoot);
    if (!hit) {
      throw new Error(
        `ModelStore: no catalog entry for alias "${DEFAULT_MODEL_ALIAS}". ` +
          `A fresh install with no model catalog is a broken install -- check that ` +
          `models/*.yaml ships in the tarball or is present in ${this.builtinDir}.`,
      );
    }
    return hit;
  }
}
