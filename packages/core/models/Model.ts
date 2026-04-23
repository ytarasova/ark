/**
 * Domain model for a catalog entry.
 *
 * `ModelDefinition` (in `packages/types/model.ts`) stays as the plain YAML
 * shape: what you read off disk, hash, serialize over RPC. This class wraps
 * one and provides behavior that belongs to the model itself: given the
 * runtime's compat modes, what slug should the provider receive? Does the
 * model support a given capability? What does an input token cost?
 *
 * Callers (dispatch, inline-resolve, UI) should NEVER reach into
 * `definition.provider_slugs` or reason about transport keys directly --
 * they go through this class.
 */

import type { ModelDefinition, ModelPricing } from "../../types/model.js";

/**
 * Transport-key mapping lives here and only here. When we add a new runtime
 * transport (direct AWS bedrock, Azure OpenAI, on-prem gateway, ...) this is
 * the one place we grow. Callers pass the runtime's `compat` list and the
 * model decides.
 */
function transportKey(compat: readonly string[] | undefined): string {
  const c = compat ?? [];
  if (c.includes("bedrock")) return "tf-bedrock";
  return "anthropic-direct";
}

export class Model {
  constructor(public readonly definition: ModelDefinition) {}

  /** Canonical id (e.g. "claude-sonnet-4-6"). */
  get id(): string {
    return this.definition.id;
  }

  /** Human-readable label for UI. */
  get display(): string {
    return this.definition.display;
  }

  /** Provider name (anthropic / openai / google / ...). */
  get provider(): string {
    return this.definition.provider;
  }

  /** Alias list (possibly empty). */
  get aliases(): readonly string[] {
    return this.definition.aliases ?? [];
  }

  /** Pricing info, when the catalog entry declares it. */
  get pricing(): ModelPricing | undefined {
    return this.definition.pricing;
  }

  /** Whether this model declares the given capability (e.g. "vision"). */
  supports(capability: string): boolean {
    return (this.definition.capabilities ?? []).includes(capability);
  }

  /**
   * Resolve the concrete provider slug to send when running under a
   * runtime with the given `compat` modes. Returns null when the model
   * does not declare a slug for that transport AND no anthropic-direct
   * fallback exists -- caller decides whether that's fatal.
   */
  slugFor(compat: readonly string[] | undefined): string | null {
    const key = transportKey(compat);
    const slugs = this.definition.provider_slugs ?? {};
    return slugs[key] ?? slugs["anthropic-direct"] ?? null;
  }

  /**
   * Strict variant -- throws when no slug is available. Useful at dispatch
   * time when the caller wants a clear error surfaced rather than a silent
   * passthrough.
   */
  requireSlugFor(compat: readonly string[] | undefined): string {
    const slug = this.slugFor(compat);
    if (!slug) {
      const key = transportKey(compat);
      throw new Error(`Model "${this.id}" has no slug for transport "${key}"`);
    }
    return slug;
  }
}

/** Convenience wrapper: given a raw ModelDefinition, build a domain Model. */
export function wrap(def: ModelDefinition): Model {
  return new Model(def);
}
