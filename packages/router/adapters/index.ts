/**
 * LLM Router -- provider adapters barrel export.
 *
 * `defaultProviderAdapterRegistry()` returns a fresh registry populated with
 * the three shipped adapters (openai/anthropic/google). Callers can further
 * `register()` custom adapters onto it.
 */

import { ProviderAdapterRegistry } from "./provider-adapter.js";
import { OpenAIAdapter } from "./openai-adapter.js";
import { AnthropicAdapter } from "./anthropic-adapter.js";
import { GoogleAdapter } from "./google-adapter.js";

export {
  ProviderAdapterRegistry,
  type ProviderAdapter,
  type AdapterRequest,
  stripRouting,
  fetchWithTimeout,
} from "./provider-adapter.js";
export { OpenAIAdapter } from "./openai-adapter.js";
export { AnthropicAdapter } from "./anthropic-adapter.js";
export { GoogleAdapter } from "./google-adapter.js";

/** Build a fresh registry pre-populated with the three shipped adapters. */
export function defaultProviderAdapterRegistry(): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry();
  registry.register(new OpenAIAdapter());
  registry.register(new AnthropicAdapter());
  registry.register(new GoogleAdapter());
  return registry;
}
