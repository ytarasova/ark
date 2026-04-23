/**
 * LLM Router -- provider registry.
 *
 * Each Provider owns a circuit breaker and delegates request/response
 * translation to a `ProviderAdapter` (see `adapters/`). Registering a new
 * upstream provider means writing one adapter and registering it with the
 * shared `ProviderAdapterRegistry`; no switch in this file changes.
 */

import type {
  ProviderConfig,
  ModelConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  CircuitBreakerState,
} from "./types.js";
import {
  defaultProviderAdapterRegistry,
  fetchWithTimeout,
  type ProviderAdapter,
  type ProviderAdapterRegistry,
} from "./adapters/index.js";
import { fetchWithRetry } from "./retry.js";

// ── Stream retry classifier ──────────────────────────────────────────────────

/**
 * Classify an error thrown from `Provider.stream()` as retryable. Matches
 * transient network / upstream conditions (5xx, 408/429, socket resets,
 * abort timeouts). Programmer errors (4xx other than 408/429, parse
 * failures) are terminal.
 */
export function isRetryableStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message ?? "";
  // HTTP status codes embedded in provider error messages.
  if (/\b(408|425|429|500|502|503|504)\b/.test(msg)) return true;
  // Network-level failures.
  if (
    /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_)/i.test(
      msg,
    )
  ) {
    return true;
  }
  if (/socket hang up|network|fetch failed|connection reset/i.test(msg)) return true;
  // AbortError (fetch timeout).
  if (err.name === "AbortError") return true;
  return false;
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

const BREAKER_THRESHOLD = 5; // failures before opening
const BREAKER_RESET_MS = 30_000; // time before half-open

class CircuitBreaker {
  private state: CircuitBreakerState = {
    failures: 0,
    last_failure: 0,
    state: "closed",
    next_attempt: 0,
  };

  isOpen(): boolean {
    if (this.state.state === "closed") return false;
    if (this.state.state === "open" && Date.now() >= this.state.next_attempt) {
      this.state.state = "half-open";
      return false;
    }
    return this.state.state === "open";
  }

  recordSuccess(): void {
    this.state.failures = 0;
    this.state.state = "closed";
  }

  recordFailure(): void {
    this.state.failures++;
    this.state.last_failure = Date.now();
    if (this.state.failures >= BREAKER_THRESHOLD) {
      this.state.state = "open";
      this.state.next_attempt = Date.now() + BREAKER_RESET_MS;
    }
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }
}

// ── Provider class ───────────────────────────────────────────────────────────

export class Provider {
  readonly config: ProviderConfig;
  readonly breaker: CircuitBreaker;
  /**
   * Sleep injection for deterministic tests. Production code uses setTimeout.
   * Test code can swap this to a mock clock to exercise Retry-After without
   * wall-clock delays.
   */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(
    config: ProviderConfig,
    private adapters: ProviderAdapterRegistry,
  ) {
    this.config = config;
    this.breaker = new CircuitBreaker();
  }

  /** Dispatch a chat completion request (non-streaming). */
  async complete(request: ChatCompletionRequest, modelId: string): Promise<ChatCompletionResponse> {
    if (this.breaker.isOpen()) {
      throw new Error(`Circuit breaker open for provider '${this.config.name}'`);
    }

    try {
      const adapter = this.resolveAdapter();
      const { url, init } = adapter.toRequest(request, modelId, this.config);
      const resp = await this.doFetch(url, init);
      const parsed = await adapter.fromResponse(resp, modelId);
      this.breaker.recordSuccess();
      return parsed;
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    }
  }

  /**
   * Inner streaming primitive — one attempt, no retry. Test code stubs this
   * method to exercise the retry wrapper without hitting the network.
   */
  protected async *streamProvider(
    request: ChatCompletionRequest,
    modelId: string,
  ): AsyncGenerator<ChatCompletionChunk> {
    const adapter = this.resolveAdapter();
    const { url, init } = adapter.toStreamRequest(request, modelId, this.config);
    const resp = await this.doFetch(url, init);
    yield* adapter.streamChunks(resp, modelId);
  }

  /**
   * Stream a chat completion with retry on transient failures. Retries ONLY
   * if no chunks have yet been yielded to the caller (yieldedAny guard) —
   * replaying after partial output would duplicate tokens. Post-yield failures
   * re-throw immediately with a message noting the partial output.
   */
  async *stream(request: ChatCompletionRequest, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    if (this.breaker.isOpen()) {
      throw new Error(`Circuit breaker open for provider '${this.config.name}'`);
    }

    const retries = this.config.max_retries ?? 2;
    let attempt = 0;
    while (true) {
      let yieldedAny = false;
      try {
        for await (const chunk of this.streamProvider(request, modelId)) {
          yieldedAny = true;
          yield chunk;
        }
        this.breaker.recordSuccess();
        return;
      } catch (err) {
        if (yieldedAny) {
          this.breaker.recordFailure();
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Stream aborted mid-response after partial output (provider=${this.config.name}): ${msg}`);
        }
        if (attempt >= retries || !isRetryableStreamError(err)) {
          this.breaker.recordFailure();
          throw err;
        }
        attempt++;
        const base = 250 * 2 ** (attempt - 1);
        const jitter = Math.random() * base * 0.3;
        await this.sleep(Math.min(base + jitter, 20_000));
      }
    }
  }

  /**
   * Resolve the adapter for this provider's name. Unknown providers fall back
   * to the OpenAI-compatible adapter (vLLM, Ollama, etc.).
   */
  private resolveAdapter(): ProviderAdapter {
    return this.adapters.resolve(this.config.name, "openai");
  }

  /**
   * Fetch with timeout + retry wrapping. Adapters call through this so every
   * provider call benefits from Batch 3's exponential-backoff + jitter +
   * Retry-After semantics, not just the pre-adapter shape.
   */
  private doFetch(url: string, opts: RequestInit): Promise<Response> {
    const timeoutMs = this.config.timeout_ms ?? 60000;
    const retries = this.config.max_retries ?? 2;
    return fetchWithRetry(() => fetchWithTimeout(url, opts, timeoutMs), {
      retries,
      onAttempt: ({ attempt, delayMs, reason }) => {
        console.error(`[router] Retry ${attempt}/${retries} for ${this.config.name} after ${delayMs}ms (${reason})`);
      },
    });
  }
}

// ── Provider Registry ────────────────────────────────────────────────────────

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  constructor(private adapters: ProviderAdapterRegistry = defaultProviderAdapterRegistry()) {}

  /**
   * Register a custom provider adapter. Any subsequent `register(...)` whose
   * provider name matches `adapter.name` will use the new strategy.
   */
  registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.register(adapter);
  }

  /** Register a provider from config. */
  register(config: ProviderConfig): void {
    this.providers.set(config.name, new Provider(config, this.adapters));
  }

  /** Get a provider by name. */
  getProvider(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  /** Get all registered providers. */
  listProviders(): Provider[] {
    return Array.from(this.providers.values());
  }

  /** Get all models across all providers. */
  listModels(): ModelConfig[] {
    return this.listProviders().flatMap((p) => p.config.models);
  }

  /** Get models filtered by tier. */
  getModelsByTier(tier: "frontier" | "standard" | "economy"): ModelConfig[] {
    return this.listModels().filter((m) => m.tier === tier);
  }

  /** Find which provider owns a specific model. */
  findProviderForModel(modelId: string): Provider | undefined {
    for (const p of this.providers.values()) {
      if (p.config.models.some((m) => m.id === modelId)) return p;
    }
    return undefined;
  }

  /** Find a model config by ID. */
  findModel(modelId: string): ModelConfig | undefined {
    for (const p of this.providers.values()) {
      const m = p.config.models.find((m) => m.id === modelId);
      if (m) return m;
    }
    return undefined;
  }
}
