/**
 * LLM Router -- provider adapter strategy interface + registry.
 *
 * Replaces the `switch (this.config.name)` anti-pattern in the Provider class
 * with a typed strategy registry. Each adapter translates the OpenAI-compatible
 * Router API to/from a specific upstream provider (Anthropic, Google, OpenAI,
 * ...). Adding a new provider means writing one adapter and registering it.
 */

import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, ProviderConfig } from "../types.js";

/** A single HTTP call description -- URL plus RequestInit (headers, body, method). */
export interface AdapterRequest {
  url: string;
  init: RequestInit;
}

/**
 * Provider adapter strategy.
 *
 * `toRequest()` builds the outbound HTTP call.
 * `fromResponse()` normalises the non-streaming response.
 * `streamChunks()` normalises the streaming response into OpenAI-format chunks.
 *
 * Adapters are stateless; the Provider class holds the circuit breaker and
 * shared fetch/retry wiring.
 */
export interface ProviderAdapter {
  readonly name: string;

  /** Build the non-streaming request. */
  toRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest;

  /** Build the streaming request. */
  toStreamRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest;

  /** Parse a non-streaming HTTP response into a ChatCompletionResponse. */
  fromResponse(resp: Response, modelId: string): Promise<ChatCompletionResponse>;

  /** Parse a streaming HTTP response into OpenAI-format chunks. */
  streamChunks(resp: Response, modelId: string): AsyncGenerator<ChatCompletionChunk>;
}

/**
 * Registry of known provider adapters, keyed by `name`. Register a new
 * adapter before constructing any Provider that uses it.
 */
export class ProviderAdapterRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  /** Register an adapter. Overwrites any existing entry with the same name. */
  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  /** Look up an adapter by name. Returns undefined if not registered. */
  get(name: string): ProviderAdapter | undefined {
    return this.adapters.get(name);
  }

  /** Resolve `name`, falling back to `fallbackName`. Throws if neither is registered. */
  resolve(name: string, fallbackName: string): ProviderAdapter {
    const primary = this.adapters.get(name);
    if (primary) return primary;
    const fallback = this.adapters.get(fallbackName);
    if (!fallback) {
      throw new Error(
        `ProviderAdapterRegistry: no adapter for '${name}' and fallback '${fallbackName}' is also missing`,
      );
    }
    return fallback;
  }

  /** All registered adapter names, in insertion order. */
  list(): string[] {
    return Array.from(this.adapters.keys());
  }
}

/** Strip the `routing` extension from an OpenAI-compatible request body. */
export function stripRouting(req: ChatCompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { ...req };
  delete body.routing;
  return body;
}

/** Shared fetch-with-timeout. Adapters do not call fetch directly. */
export async function fetchWithTimeout(url: string, opts: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
