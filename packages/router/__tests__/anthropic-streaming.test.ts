/**
 * Anthropic streaming adapter tests.
 *
 * Covers the translation of Anthropic SSE events (content_block_start,
 * content_block_delta, message_delta) into OpenAI-compatible chunks. In
 * particular, asserts that tool-use blocks produce OpenAI streaming
 * `tool_calls` deltas (not `content` deltas) so downstream OpenAI clients
 * can reassemble them correctly.
 */

import { describe, test, expect } from "bun:test";
import { AnthropicAdapter } from "../adapters/anthropic-adapter.js";
import type { ChatCompletionChunk } from "../types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function sseBody(events: Array<Record<string, unknown>>): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const ch of gen) out.push(ch);
  return out;
}

// Run SSE events through the adapter's streamChunks method.
function parseSSE(_unused: unknown, resp: Response): AsyncGenerator<ChatCompletionChunk> {
  const adapter = new AnthropicAdapter();
  return adapter.streamChunks(resp, "claude-test");
}

function makeAnthropicProvider(): unknown {
  // Placeholder kept for signature compatibility with legacy test helpers;
  // the adapter path no longer needs a Provider instance.
  return null;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("Anthropic streaming adapter", () => {
  test("text_delta events become delta.content chunks", async () => {
    const provider = makeAnthropicProvider();
    const resp = sseBody([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 2 } },
    ]);
    const chunks = await collect(parseSSE(provider, resp));

    const textDeltas = chunks.filter((c) => typeof c.choices[0]?.delta.content === "string");
    expect(textDeltas.map((c) => c.choices[0].delta.content).join("")).toBe("hello world");

    const final = chunks[chunks.length - 1];
    expect(final.choices[0].finish_reason).toBe("stop");
  });

  test("input_json_delta events emit OpenAI streaming tool_calls shape", async () => {
    const provider = makeAnthropicProvider();
    const resp = sseBody([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_abc", name: "get_weather", input: {} },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"SF"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
    const chunks = await collect(parseSSE(provider, resp));

    // Collect the tool_calls deltas (chunks whose delta carries a tool_calls array).
    const toolDeltas = chunks
      .map((c) => (c.choices[0]?.delta as { tool_calls?: Array<Record<string, unknown>> }).tool_calls)
      .filter((tc): tc is Array<Record<string, unknown>> => Array.isArray(tc));

    expect(toolDeltas.length).toBe(2);

    // First delta: full metadata (id, type, function.name) + partial arguments.
    const first = toolDeltas[0][0];
    expect(first.index).toBe(0);
    expect(first.id).toBe("toolu_abc");
    expect(first.type).toBe("function");
    expect((first.function as Record<string, unknown>).name).toBe("get_weather");
    expect((first.function as Record<string, unknown>).arguments).toBe('{"city":');

    // Second delta: only index + function.arguments (no id/type re-emission).
    const second = toolDeltas[1][0];
    expect(second.index).toBe(0);
    expect(second.id).toBeUndefined();
    expect(second.type).toBeUndefined();
    const secondFn = second.function as Record<string, unknown>;
    expect(secondFn.arguments).toBe('"SF"}');
    expect(secondFn.name).toBeUndefined();

    // Argument stream reassembles to the full JSON payload.
    const combined = toolDeltas.map((tc) => (tc[0].function as Record<string, unknown>).arguments as string).join("");
    expect(combined).toBe('{"city":"SF"}');

    // Final chunk carries finish_reason tool_calls from message_delta.
    const final = chunks[chunks.length - 1];
    expect(final.choices[0].finish_reason).toBe("tool_calls");
  });

  test("text and tool_use blocks at different indices are tracked independently", async () => {
    const provider = makeAnthropicProvider();
    const resp = sseBody([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "thinking..." } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_xyz", name: "search" },
      },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"q":"ark"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
    const chunks = await collect(parseSSE(provider, resp));

    const contentDelta = chunks.find((c) => typeof c.choices[0]?.delta.content === "string");
    expect(contentDelta?.choices[0].delta.content).toBe("thinking...");

    const toolDelta = chunks.find((c) => Array.isArray((c.choices[0]?.delta as { tool_calls?: unknown[] }).tool_calls));
    const tc = (toolDelta?.choices[0].delta as { tool_calls: Array<Record<string, unknown>> }).tool_calls[0];
    expect(tc.index).toBe(1);
    expect(tc.id).toBe("toolu_xyz");
    expect((tc.function as Record<string, unknown>).name).toBe("search");
  });
});
