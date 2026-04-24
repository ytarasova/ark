/**
 * ModelService -- domain service over the catalog.
 *
 * Wraps a `ModelStore` (the three-layer file-backed lookup) and returns
 * domain `Model` instances instead of raw definitions. This is the layer
 * dispatch, inline-resolve, and the UI should talk to. They never reach
 * into the store directly.
 *
 * Keep this free of AppContext, session state, or dispatch-specific
 * concerns -- it's a pure domain service.
 */

import type { ModelStore } from "../stores/model-store.js";
import { Model } from "./Model.js";

export class ModelService {
  constructor(private readonly store: ModelStore) {}

  /**
   * Resolve an id/alias to a domain Model. Returns null on catalog miss.
   * Callers that want to hard-fail on miss should use `require()` below.
   */
  get(idOrAlias: string, projectRoot?: string): Model | null {
    // Provider-qualified slugs (anything containing "/") bypass the catalog --
    // they're a deliberate out-of-band override.
    if (idOrAlias.includes("/")) return null;
    const def = this.store.get(idOrAlias, projectRoot);
    return def ? new Model(def) : null;
  }

  /**
   * Strict variant: throws when the id/alias isn't in the catalog and
   * isn't an explicit provider-qualified slug. Lists available ids in
   * the error for fast triage.
   */
  require(idOrAlias: string, projectRoot?: string): Model {
    const m = this.get(idOrAlias, projectRoot);
    if (m) return m;
    if (idOrAlias.includes("/")) {
      throw new Error(
        `require() called with a provider-qualified slug "${idOrAlias}" -- use get() or pass a catalog id/alias instead`,
      );
    }
    const ids = this.store
      .list(projectRoot)
      .map((d) => d.id)
      .sort();
    throw new Error(`Model "${idOrAlias}" not found in catalog. Available: [${ids.join(", ")}]`);
  }

  /**
   * One-shot dispatch helper: turn a catalog id/alias into the concrete
   * provider slug the runtime should send. Explicit provider-qualified
   * slugs (containing "/") pass through untouched.
   *
   * Returns null when the catalog doesn't know this id -- callers should
   * treat that as "let the raw string flow through", not as an error, so
   * experimental out-of-catalog ids keep working.
   */
  resolveSlug(idOrAlias: string, compat: readonly string[] | undefined, projectRoot?: string): string | null {
    if (idOrAlias.includes("/")) return idOrAlias;
    const model = this.get(idOrAlias, projectRoot);
    return model?.slugFor(compat) ?? null;
  }

  /**
   * Default model for UI / seed paths. Resolves the `sonnet` alias, which
   * the catalog maps to the current-generation Anthropic Sonnet. Throws on
   * empty catalog -- a fresh install with no catalog is a broken install.
   */
  default(projectRoot?: string): Model {
    return this.require("sonnet", projectRoot);
  }

  /** Enumerate every model in the catalog. */
  list(projectRoot?: string): Model[] {
    return this.store.list(projectRoot).map((d) => new Model(d));
  }
}
