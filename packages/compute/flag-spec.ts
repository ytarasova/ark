/**
 * ProviderFlagSpec -- CLI-layer adapter for provider-specific flag handling.
 *
 * Each compute provider that accepts CLI-exposed knobs (image, size, region,
 * namespace, ...) ships a `ProviderFlagSpec`. The `ark compute create` command
 * walks the registry to register its own Commander options, and -- once the
 * user's provider is known -- delegates `configFromFlags()` and
 * `displaySummary()` to the matching spec. This keeps provider-specific CLI
 * knowledge co-located with the provider instead of an ever-growing
 * if/else chain in `packages/cli/commands/compute.ts`.
 *
 * Design notes:
 *   - Flag specs are CLI adapters, NOT part of the core Compute/Runtime
 *     interfaces (`packages/compute/core/types.ts`). Do not import them from
 *     runtime code paths.
 *   - Aliases (`k8s-kata` -> same spec as `k8s`) are handled in the registry.
 *   - `options` are plain descriptors so the CLI can apply `.option()` with
 *     its own `program` reference without each spec owning a Commander dep.
 */

export interface ProviderFlagOption {
  /** Commander-style flag string, eg `"--image <image>"`. */
  flag: string;
  /** Help text shown by `--help`. */
  description: string;
  /** Optional default value applied when the user does not pass the flag. */
  default?: string;
}

export interface ProviderFlagSpec {
  /** Stable provider key matching the `--provider` value / legacy DB column. */
  name: string;
  /** Commander option defs this provider contributes. */
  options: ProviderFlagOption[];
  /** Turn raw CLI opts into the provider's config object. */
  configFromFlags(opts: Record<string, unknown>): Record<string, unknown>;
  /** Render post-create summary lines. Returns string[]. */
  displaySummary(config: Record<string, unknown>, opts: Record<string, unknown>): string[];
}
