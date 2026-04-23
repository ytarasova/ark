/**
 * Provider.stream() retry semantics.
 *
 * Covers the Provider.stream() retry budget for mid-stream failures. The
 * critical invariant: if ANY chunk has already been yielded to the caller,
 * we do NOT retry (would duplicate output). Otherwise, classified-retryable
 * failures are retried up to `config.max_retries` attempts.
 */

import { describe, test, expect } from "bun:test";
import { Provider, isRetryableStreamError } from "../providers.js";
import type { ChatCompletionChunk, ChatCompletionRequest, ProviderConfig } from "../types.js";

function makeProvider(overrides: Partial<ProviderConfig> = {}): Provider {
  return new Provider({
    name: "openai",
    api_key: "test",
    base_url: "https://api.openai.example",
    models: [
      {
        id: "gpt-test",
        provider: "openai",
        tier: "frontier",
        cost_input: 0,
        cost_output: 0,
        max_context: 100,
        supports_tools: true,
        quality: 0.9,
      },
    ],
    max_retries: 2,
    ...overrides,
  });
}

function dummyChunk(text: string): ChatCompletionChunk {
  return {
    id: "c-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "gpt-test",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const ch of gen) out.push(ch);
  return out;
}

// Monkey-patch streamProvider on the Provider instance so we do not hit the
// real network. Each array entry is a function that returns an async
// generator (fresh per attempt so retries start clean).
function stubStreamProvider(
  provider: Provider,
  attempts: Array<() => AsyncGenerator<ChatCompletionChunk>>,
): { calls: number } {
  const tracker = { calls: 0 };
  (
    provider as unknown as { streamProvider: (req: unknown, id: unknown) => AsyncGenerator<ChatCompletionChunk> }
  ).streamProvider = (_req: unknown, _id: unknown) => {
    const fn = attempts[tracker.calls] ?? attempts[attempts.length - 1];
    tracker.calls++;
    return fn();
  };
  return tracker;
}

const req: ChatCompletionRequest = { model: "gpt-test", messages: [{ role: "user", content: "hi" }] };

describe("isRetryableStreamError", () => {
  test("classifies 5xx as retryable", () => {
    expect(isRetryableStreamError(new Error("OpenAI streaming error 503: upstream overloaded"))).toBe(true);
    expect(isRetryableStreamError(new Error("Anthropic API error 500: internal"))).toBe(true);
  });
  test("classifies 429 as retryable", () => {
    expect(isRetryableStreamError(new Error("error 429 rate limited"))).toBe(true);
  });
  test("classifies 4xx (other) as non-retryable", () => {
    expect(isRetryableStreamError(new Error("error 400 bad request"))).toBe(false);
    expect(isRetryableStreamError(new Error("error 401 unauthorized"))).toBe(false);
  });
  test("classifies socket errors as retryable", () => {
    expect(isRetryableStreamError(new Error("socket hang up"))).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableStreamError(abort)).toBe(true);
  });
  test("classifies unclassified errors as non-retryable", () => {
    expect(isRetryableStreamError(new Error("some parse failure"))).toBe(false);
    expect(isRetryableStreamError("not an error")).toBe(false);
  });
});

describe("Provider.stream() retry", () => {
  test("retries on retryable failure before any chunk yielded", async () => {
    const provider = makeProvider({ max_retries: 2 });
    const tracker = stubStreamProvider(provider, [
      async function* () {
        throw new Error("OpenAI streaming error 503: upstream overloaded");
      },
      async function* () {
        yield dummyChunk("ok");
      },
    ]);

    const chunks = await collect(provider.stream(req, "gpt-test"));
    expect(tracker.calls).toBe(2);
    expect(chunks.length).toBe(1);
    expect(chunks[0].choices[0].delta.content).toBe("ok");
  });

  test("does NOT retry after chunks have been yielded (yieldedAny guard)", async () => {
    const provider = makeProvider({ max_retries: 3 });
    const tracker = stubStreamProvider(provider, [
      async function* () {
        yield dummyChunk("part-1");
        throw new Error("OpenAI streaming error 503: connection reset mid-stream");
      },
      async function* () {
        // Should never be reached because yieldedAny=true after the first chunk.
        yield dummyChunk("part-2");
      },
    ]);

    const out: ChatCompletionChunk[] = [];
    let caught: Error | null = null;
    try {
      for await (const ch of provider.stream(req, "gpt-test")) {
        out.push(ch);
      }
    } catch (err) {
      caught = err as Error;
    }

    expect(tracker.calls).toBe(1);
    expect(out.length).toBe(1);
    expect(out[0].choices[0].delta.content).toBe("part-1");
    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/partial output/i);
  });

  test("does NOT retry non-retryable failures", async () => {
    const provider = makeProvider({ max_retries: 3 });
    const tracker = stubStreamProvider(provider, [
      async function* () {
        throw new Error("OpenAI streaming error 401: invalid api key");
      },
    ]);

    let caught: Error | null = null;
    try {
      for await (const _ of provider.stream(req, "gpt-test")) {
        /* drain */
      }
    } catch (err) {
      caught = err as Error;
    }

    expect(tracker.calls).toBe(1);
    expect(caught?.message).toMatch(/401/);
  });

  test("exhausts retry budget on sustained failure", async () => {
    const provider = makeProvider({ max_retries: 2 });
    const tracker = stubStreamProvider(provider, [
      async function* () {
        throw new Error("error 503");
      },
      async function* () {
        throw new Error("error 503");
      },
      async function* () {
        throw new Error("error 503");
      },
    ]);

    let caught: Error | null = null;
    try {
      for await (const _ of provider.stream(req, "gpt-test")) {
        /* drain */
      }
    } catch (err) {
      caught = err as Error;
    }

    // 1 initial + 2 retries = 3 calls.
    expect(tracker.calls).toBe(3);
    expect(caught?.message).toMatch(/503/);
  });
});
