/**
 * Tests for pluggable provider adapters (Open/Closed Principle).
 *
 * Verifies that the Provider class dispatches to a registered custom adapter
 * without any switch/case modification in providers.ts.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { ProviderRegistry } from "../providers.js";
import { defaultProviderAdapterRegistry, type AdapterRequest, type ProviderAdapter } from "../adapters/index.js";
import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, ProviderConfig } from "../types.js";

// ── Fake adapter that records calls and serves static responses ──────────────

class FakeMistralAdapter implements ProviderAdapter {
  readonly name = "mistral";
  toRequestCalls = 0;
  fromResponseCalls = 0;
  streamCalls = 0;
  lastModelId = "";

  toRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest {
    this.toRequestCalls++;
    this.lastModelId = modelId;
    return {
      url: `${cfg.base_url}/fake/mistral/${modelId}`,
      init: { method: "POST", body: JSON.stringify({ prompt: req.messages }) },
    };
  }

  toStreamRequest(_req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest {
    return { url: `${cfg.base_url}/fake/mistral/${modelId}/stream`, init: { method: "POST" } };
  }

  async fromResponse(_resp: Response, modelId: string): Promise<ChatCompletionResponse> {
    this.fromResponseCalls++;
    return {
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "mistral-reply" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
  }

  async *streamChunks(_resp: Response, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    this.streamCalls++;
    yield {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{ index: 0, delta: { content: "mistral-chunk" }, finish_reason: null }],
    };
  }
}

// ── Fetch interceptor: replaces global fetch for the duration of a test ─────

function withStubbedFetch<T>(stub: (url: string, opts: RequestInit) => Response, run: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    return stub(url, init);
  }) as typeof fetch;
  return run().finally(() => {
    globalThis.fetch = orig;
  });
}

function okResponse(body = ""): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ProviderAdapter extensibility", () => {
  test("Provider dispatches complete() to a registered custom adapter", async () => {
    const adapters = defaultProviderAdapterRegistry();
    const fake = new FakeMistralAdapter();
    adapters.register(fake);

    const registry = new ProviderRegistry(adapters);
    registry.register({
      name: "mistral",
      base_url: "http://localhost:0",
      models: [
        {
          id: "mistral-large",
          provider: "mistral",
          tier: "standard",
          cost_input: 2,
          cost_output: 6,
          max_context: 128000,
          supports_tools: true,
          quality: 0.9,
        },
      ],
    });

    const provider = registry.getProvider("mistral")!;
    expect(provider).toBeDefined();

    const resp = await withStubbedFetch(
      () => okResponse("{}"),
      () => provider.complete({ model: "auto", messages: [{ role: "user", content: "hi" }] }, "mistral-large"),
    );

    expect(fake.toRequestCalls).toBe(1);
    expect(fake.fromResponseCalls).toBe(1);
    expect(fake.lastModelId).toBe("mistral-large");
    expect(resp.choices[0].message.content).toBe("mistral-reply");
  });

  test("Provider dispatches stream() to a registered custom adapter", async () => {
    const adapters = defaultProviderAdapterRegistry();
    const fake = new FakeMistralAdapter();
    adapters.register(fake);

    const registry = new ProviderRegistry(adapters);
    registry.register({
      name: "mistral",
      base_url: "http://localhost:0",
      models: [
        {
          id: "mistral-large",
          provider: "mistral",
          tier: "standard",
          cost_input: 2,
          cost_output: 6,
          max_context: 128000,
          supports_tools: true,
          quality: 0.9,
        },
      ],
    });

    const provider = registry.getProvider("mistral")!;
    const chunks: ChatCompletionChunk[] = [];

    await withStubbedFetch(
      () => okResponse(""),
      async () => {
        for await (const c of provider.stream(
          { model: "auto", messages: [{ role: "user", content: "hi" }] },
          "mistral-large",
        )) {
          chunks.push(c);
        }
      },
    );

    expect(fake.streamCalls).toBe(1);
    expect(chunks.length).toBe(1);
    expect(chunks[0].choices[0].delta.content).toBe("mistral-chunk");
  });

  test("ProviderRegistry.registerAdapter makes adapters available to existing providers", async () => {
    // Register the provider first, then add the adapter.
    const registry = new ProviderRegistry();
    const fake = new FakeMistralAdapter();
    registry.registerAdapter(fake);
    registry.register({
      name: "mistral",
      base_url: "http://localhost:0",
      models: [
        {
          id: "mistral-small",
          provider: "mistral",
          tier: "economy",
          cost_input: 0.5,
          cost_output: 1.5,
          max_context: 32000,
          supports_tools: true,
          quality: 0.82,
        },
      ],
    });

    const provider = registry.getProvider("mistral")!;
    await withStubbedFetch(
      () => okResponse("{}"),
      () => provider.complete({ model: "auto", messages: [{ role: "user", content: "hi" }] }, "mistral-small"),
    );
    expect(fake.toRequestCalls).toBe(1);
  });

  test("Unknown provider name falls back to the OpenAI adapter", async () => {
    // No custom adapter registered for "my-ollama-fork" -- should use OpenAI.
    const registry = new ProviderRegistry();
    registry.register({
      name: "my-ollama-fork",
      base_url: "http://localhost:11434",
      models: [
        {
          id: "llama3-8b",
          provider: "my-ollama-fork",
          tier: "economy",
          cost_input: 0,
          cost_output: 0,
          max_context: 8192,
          supports_tools: false,
          quality: 0.7,
        },
      ],
    });

    const provider = registry.getProvider("my-ollama-fork")!;

    let seenUrl = "";
    await withStubbedFetch(
      (url) => {
        seenUrl = url;
        return okResponse(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "llama3-8b",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
      },
      () => provider.complete({ model: "auto", messages: [{ role: "user", content: "hi" }] }, "llama3-8b"),
    );

    expect(seenUrl).toBe("http://localhost:11434/v1/chat/completions");
  });
});
