/**
 * Canonical shape of a model definition loaded from `models/*.yaml`.
 *
 * The catalog resolves an agent-supplied model id or alias to the concrete
 * provider slug the effective runtime needs at dispatch time. Today Ark
 * hardcodes this mapping in two places (runtime YAMLs and the agent-sdk
 * bedrock-compat branch in launch.ts); the catalog replaces both.
 *
 * This type is intentionally plain / JSON-friendly so control-plane mode can
 * eventually persist it the same way as other resource definitions.
 */
export interface ModelPricing {
  /** USD per million input tokens. */
  input_per_mtok?: number;
  /** USD per million cached-input tokens (Anthropic prompt caching). */
  cached_input_per_mtok?: number;
  /** USD per million output tokens. */
  output_per_mtok?: number;
}

export interface ModelDefinition {
  /** Canonical, filename-style id (e.g. `claude-sonnet-4-6`). Unique across the catalog. */
  id: string;
  /** Human-readable label shown in UIs. */
  display: string;
  /** Upstream vendor the model comes from (anthropic, openai, google, ...). */
  provider: string;
  /** Short alternate names callers may pass in (e.g. `sonnet`, `opus`). Unique across the catalog. */
  aliases?: string[];
  /** Capability tags (e.g. `tool-use`, `vision`, `1m-context`). */
  capabilities?: string[];
  /** Optional published pricing; omit when genuinely unknown. */
  pricing?: ModelPricing;
  /**
   * Map from provider key (the access path: `anthropic-direct`, `tf-bedrock`,
   * `aws-bedrock`, `openai-direct`, ...) to the concrete model slug that
   * provider expects on the wire.
   */
  provider_slugs: Record<string, string>;
  /** Context window in tokens. */
  context_window?: number;
}
