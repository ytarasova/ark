/**
 * LLM Router -- policy selector strategy interface + registry.
 *
 * Replaces the `switch (policy)` anti-pattern in the routing engine with
 * a typed strategy registry. Callers resolve a policy by name and delegate
 * selection to the implementation; registering a new policy does not require
 * modifying any existing code (Open/Closed Principle).
 */

import type { ModelConfig, RouterConfig, RoutingPolicy } from "../types.js";
import type { ClassificationResult } from "../classifier.js";

/**
 * A PolicySelector picks one model from a set of candidates for a given
 * classification, under a given router configuration (quality floor, etc.).
 *
 * Implementations MUST be pure -- no hidden state, no side effects.
 */
export interface PolicySelector {
  /** Unique policy identifier. Matches the `RoutingPolicy` value on requests. */
  readonly name: string;

  /** Pick a model from `candidates`. Never return null/undefined; throw if impossible. */
  select(candidates: ModelConfig[], classification: ClassificationResult, cfg: RouterConfig): ModelConfig;

  /**
   * Explain why a non-selected candidate was skipped. Used to populate
   * `RoutingDecision.alternatives_considered[].reason_skipped`.
   */
  skipReason(model: ModelConfig, selected: ModelConfig, cfg: RouterConfig): string | null;
}

/**
 * Registry of known policy selectors, keyed by `name`. New policies can be
 * added via `register()` without touching the engine.
 */
export class PolicyRegistry {
  private selectors = new Map<string, PolicySelector>();

  /** Register a selector. Overwrites any existing entry with the same name. */
  register(selector: PolicySelector): void {
    this.selectors.set(selector.name, selector);
  }

  /** Look up a selector by name. Returns undefined if not registered. */
  get(name: string): PolicySelector | undefined {
    return this.selectors.get(name);
  }

  /** Return the selector for `name`, or `fallbackName` if the primary is missing. */
  resolve(name: string, fallbackName: RoutingPolicy): PolicySelector {
    const primary = this.selectors.get(name);
    if (primary) return primary;
    const fallback = this.selectors.get(fallbackName);
    if (!fallback) {
      throw new Error(`PolicyRegistry: no selector for '${name}' and fallback '${fallbackName}' is also missing`);
    }
    return fallback;
  }

  /** All registered policy names, in insertion order. */
  list(): string[] {
    return Array.from(this.selectors.keys());
  }
}

/** Pick the cheapest model by input+output cost. Exported for reuse by policies. */
export function cheapest(models: ModelConfig[]): ModelConfig {
  return models.reduce((best, m) => {
    const bestCost = best.cost_input + best.cost_output;
    const mCost = m.cost_input + m.cost_output;
    return mCost < bestCost ? m : best;
  }, models[0]);
}

/** Pick the highest-quality model. Exported for reuse by policies. */
export function highestQuality(models: ModelConfig[]): ModelConfig {
  return models.reduce((best, m) => (m.quality > best.quality ? m : best), models[0]);
}
