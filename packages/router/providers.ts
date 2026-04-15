/**
 * LLM Router -- provider registry and adapters.
 *
 * Each provider adapts its native API to OpenAI-compatible request/response.
 * - Anthropic: converts OpenAI format <-> Messages API
 * - OpenAI: passthrough (native format)
 * - Google: converts <-> Gemini API
 * - Ollama/vLLM: passthrough (OpenAI-compatible)
 *
 * Circuit breakers per provider prevent cascading failures.
 */

import type {
  ProviderConfig,
  ModelConfig,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  CircuitBreakerState,
} from "./types.js";

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

  constructor(config: ProviderConfig) {
    this.config = config;
    this.breaker = new CircuitBreaker();
  }

  /** Dispatch a chat completion request (non-streaming). */
  async complete(request: ChatCompletionRequest, modelId: string): Promise<ChatCompletionResponse> {
    if (this.breaker.isOpen()) {
      throw new Error(`Circuit breaker open for provider '${this.config.name}'`);
    }

    try {
      let response: ChatCompletionResponse;
      switch (this.config.name) {
        case "anthropic":
          response = await this.completeAnthropic(request, modelId);
          break;
        case "google":
          response = await this.completeGoogle(request, modelId);
          break;
        case "openai":
        default:
          response = await this.completeOpenAI(request, modelId);
          break;
      }
      this.breaker.recordSuccess();
      return response;
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    }
  }

  /** Stream a chat completion (returns an async generator of chunks). */
  async *stream(request: ChatCompletionRequest, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    if (this.breaker.isOpen()) {
      throw new Error(`Circuit breaker open for provider '${this.config.name}'`);
    }

    try {
      switch (this.config.name) {
        case "anthropic":
          yield* this.streamAnthropic(request, modelId);
          break;
        case "google":
          yield* this.streamGoogle(request, modelId);
          break;
        case "openai":
        default:
          yield* this.streamOpenAI(request, modelId);
          break;
      }
      this.breaker.recordSuccess();
    } catch (err) {
      this.breaker.recordFailure();
      throw err;
    }
  }

  // ── OpenAI adapter (passthrough) ───────────────────────────────────────────

  private async completeOpenAI(request: ChatCompletionRequest, modelId: string): Promise<ChatCompletionResponse> {
    const body: Record<string, unknown> = { ...request, model: modelId, stream: false };
    delete body.routing;

    const resp = await this.fetchWithTimeout(`${this.config.base_url}/v1/chat/completions`, {
      method: "POST",
      headers: this.openaiHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${text}`);
    }

    return (await resp.json()) as ChatCompletionResponse;
  }

  private async *streamOpenAI(request: ChatCompletionRequest, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    const body: Record<string, unknown> = { ...request, model: modelId, stream: true };
    delete body.routing;

    const resp = await this.fetchWithTimeout(`${this.config.base_url}/v1/chat/completions`, {
      method: "POST",
      headers: this.openaiHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI streaming error ${resp.status}: ${text}`);
    }

    yield* this.parseSSE(resp);
  }

  private openaiHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.api_key}`,
    };
  }

  // ── Anthropic adapter ──────────────────────────────────────────────────────

  private async completeAnthropic(request: ChatCompletionRequest, modelId: string): Promise<ChatCompletionResponse> {
    const anthropicBody = this.toAnthropicRequest(request, modelId);

    const resp = await this.fetchWithTimeout(`${this.config.base_url}/v1/messages`, {
      method: "POST",
      headers: this.anthropicHeaders(),
      body: JSON.stringify(anthropicBody),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    const anthropicResp = await resp.json();
    return this.fromAnthropicResponse(anthropicResp, modelId);
  }

  private async *streamAnthropic(request: ChatCompletionRequest, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    const anthropicBody = { ...this.toAnthropicRequest(request, modelId), stream: true };

    const resp = await this.fetchWithTimeout(`${this.config.base_url}/v1/messages`, {
      method: "POST",
      headers: this.anthropicHeaders(),
      body: JSON.stringify(anthropicBody),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic streaming error ${resp.status}: ${text}`);
    }

    // Anthropic uses a different SSE format -- parse and convert to OpenAI chunks
    yield* this.parseAnthropicSSE(resp, modelId);
  }

  private toAnthropicRequest(request: ChatCompletionRequest, modelId: string): Record<string, unknown> {
    // Extract system message (Anthropic uses top-level `system` field)
    let systemPrompt: string | undefined;
    const messages: Array<{ role: string; content: string | unknown[] }> = [];

    for (const msg of request.messages) {
      if (msg.role === "system") {
        systemPrompt = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        continue;
      }

      // Convert tool calls in assistant messages
      if (msg.role === "assistant" && msg.tool_calls?.length) {
        const content: unknown[] = [];
        if (msg.content) {
          content.push({
            type: "text",
            text: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
          });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
        messages.push({ role: "assistant", content });
        continue;
      }

      // Convert tool results
      if (msg.role === "tool" && msg.tool_call_id) {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
            },
          ],
        });
        continue;
      }

      messages.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      });
    }

    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      max_tokens: request.max_tokens ?? 4096,
    };

    if (systemPrompt) body.system = systemPrompt;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.stop) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];

    // Convert tools
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      }));
    }

    if (request.tool_choice) {
      if (request.tool_choice === "auto") {
        body.tool_choice = { type: "auto" };
      } else if (request.tool_choice === "none") {
        body.tool_choice = { type: "none" };
      } else if (typeof request.tool_choice === "object") {
        const tc = request.tool_choice as { function?: { name?: string } };
        if (tc.function?.name) {
          body.tool_choice = { type: "tool", name: tc.function.name };
        }
      }
    }

    return body;
  }

  private fromAnthropicResponse(resp: any, modelId: string): ChatCompletionResponse {
    const content = resp.content || [];
    let textContent = "";
    const toolCalls: any[] = [];

    for (const block of content) {
      if (block.type === "text") {
        textContent += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
      }
    }

    const finishReason: "stop" | "length" | "tool_calls" =
      resp.stop_reason === "end_turn"
        ? "stop"
        : resp.stop_reason === "tool_use"
          ? "tool_calls"
          : resp.stop_reason === "max_tokens"
            ? "length"
            : "stop";

    return {
      id: resp.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: textContent || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: resp.usage?.input_tokens ?? 0,
        completion_tokens: resp.usage?.output_tokens ?? 0,
        total_tokens: (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0),
      },
    };
  }

  private async *parseAnthropicSSE(resp: Response, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    const reader = resp.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";
    const chunkId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          // Convert Anthropic SSE events to OpenAI chunk format
          if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta") {
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta.text },
                    finish_reason: null,
                  },
                ],
              };
            } else if (event.delta?.type === "input_json_delta") {
              // Tool call argument streaming -- accumulate as content for simplicity
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta.partial_json },
                    finish_reason: null,
                  },
                ],
              };
            }
          } else if (event.type === "message_delta") {
            const stopReason = event.delta?.stop_reason;
            const finishReason =
              stopReason === "end_turn"
                ? "stop"
                : stopReason === "tool_use"
                  ? "tool_calls"
                  : stopReason === "max_tokens"
                    ? "length"
                    : null;

            yield {
              id: chunkId,
              object: "chat.completion.chunk",
              created,
              model: modelId,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: finishReason,
                },
              ],
              usage: event.usage
                ? {
                    prompt_tokens: event.usage.input_tokens ?? 0,
                    completion_tokens: event.usage.output_tokens ?? 0,
                    total_tokens: (event.usage.input_tokens ?? 0) + (event.usage.output_tokens ?? 0),
                  }
                : undefined,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private anthropicHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": this.config.api_key ?? "",
      "anthropic-version": "2023-06-01",
    };
  }

  // ── Google Gemini adapter ──────────────────────────────────────────────────

  private async completeGoogle(request: ChatCompletionRequest, modelId: string): Promise<ChatCompletionResponse> {
    const geminiBody = this.toGeminiRequest(request);
    const url = `${this.config.base_url}/v1beta/models/${modelId}:generateContent?key=${this.config.api_key}`;

    const resp = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Google API error ${resp.status}: ${text}`);
    }

    const geminiResp = await resp.json();
    return this.fromGeminiResponse(geminiResp, modelId);
  }

  private async *streamGoogle(request: ChatCompletionRequest, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    const geminiBody = this.toGeminiRequest(request);
    const url = `${this.config.base_url}/v1beta/models/${modelId}:streamGenerateContent?key=${this.config.api_key}&alt=sse`;

    const resp = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Google streaming error ${resp.status}: ${text}`);
    }

    const chunkId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const reader = resp.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const text = event.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
          const finishReason = event.candidates?.[0]?.finishReason;

          yield {
            id: chunkId,
            object: "chat.completion.chunk",
            created,
            model: modelId,
            choices: [
              {
                index: 0,
                delta: text ? { content: text } : {},
                finish_reason: finishReason === "STOP" ? "stop" : finishReason === "MAX_TOKENS" ? "length" : null,
              },
            ],
          };
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private toGeminiRequest(request: ChatCompletionRequest): Record<string, unknown> {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;

    for (const msg of request.messages) {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");

      if (msg.role === "system") {
        systemInstruction = { parts: [{ text }] };
        continue;
      }

      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text }],
      });
    }

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.max_tokens !== undefined) generationConfig.maxOutputTokens = request.max_tokens;
    if (request.top_p !== undefined) generationConfig.topP = request.top_p;
    if (request.stop) generationConfig.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Convert tools for Gemini
    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description ?? "",
            parameters: t.function.parameters ?? { type: "OBJECT", properties: {} },
          })),
        },
      ];
    }

    return body;
  }

  private fromGeminiResponse(resp: any, modelId: string): ChatCompletionResponse {
    const candidate = resp.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text ?? "";
    const finishReason: "stop" | "length" =
      candidate?.finishReason === "STOP" ? "stop" : candidate?.finishReason === "MAX_TOKENS" ? "length" : "stop";

    const usage = resp.usageMetadata ?? {};

    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokenCount ?? 0,
        completion_tokens: usage.candidatesTokenCount ?? 0,
        total_tokens: usage.totalTokenCount ?? 0,
      },
    };
  }

  // ── Shared SSE parser (OpenAI format) ──────────────────────────────────────

  private async *parseSSE(resp: Response): AsyncGenerator<ChatCompletionChunk> {
    const reader = resp.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") return;

          try {
            yield JSON.parse(data) as ChatCompletionChunk;
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Fetch with timeout ─────────────────────────────────────────────────────

  private async fetchWithTimeout(url: string, opts: RequestInit): Promise<Response> {
    const timeout = this.config.timeout_ms ?? 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Provider Registry ────────────────────────────────────────────────────────

export class ProviderRegistry {
  private providers = new Map<string, Provider>();

  /** Register a provider from config. */
  register(config: ProviderConfig): void {
    this.providers.set(config.name, new Provider(config));
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
