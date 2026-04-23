/**
 * Anthropic (Messages API) adapter. Converts OpenAI-format requests to
 * Anthropic's Messages API and normalises responses back to OpenAI format.
 */

import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, ProviderConfig } from "../types.js";
import type { AdapterRequest, ProviderAdapter } from "./provider-adapter.js";

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = "anthropic";

  toRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest {
    return {
      url: `${cfg.base_url}/v1/messages`,
      init: {
        method: "POST",
        headers: this.headers(cfg),
        body: JSON.stringify(this.toAnthropicBody(req, modelId)),
      },
    };
  }

  toStreamRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest {
    const body = { ...this.toAnthropicBody(req, modelId), stream: true };
    return {
      url: `${cfg.base_url}/v1/messages`,
      init: { method: "POST", headers: this.headers(cfg), body: JSON.stringify(body) },
    };
  }

  async fromResponse(resp: Response, modelId: string): Promise<ChatCompletionResponse> {
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }
    const raw = await resp.json();
    return this.fromAnthropicResponse(raw, modelId);
  }

  async *streamChunks(resp: Response, modelId: string): AsyncGenerator<ChatCompletionChunk> {
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic streaming error ${resp.status}: ${text}`);
    }
    const reader = resp.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";
    const chunkId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // Track tool_use content blocks by Anthropic block index so input_json_delta
    // events translate into OpenAI streaming tool_calls deltas. The first delta
    // per tool call carries id/type/function.name; subsequent deltas carry only
    // function.arguments (partial JSON). Text blocks are emitted as delta.content
    // and do not need tracking.
    const toolBlocks = new Map<number, { id: string; name: string; firstDeltaEmitted: boolean }>();

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

          if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "tool_use" && typeof event.index === "number") {
              toolBlocks.set(event.index, {
                id: block.id ?? "",
                name: block.name ?? "",
                firstDeltaEmitted: false,
              });
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta?.type === "text_delta") {
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
              };
            } else if (event.delta?.type === "input_json_delta") {
              const blockIndex = typeof event.index === "number" ? event.index : 0;
              const tracked = toolBlocks.get(blockIndex);
              const partial = event.delta.partial_json ?? "";
              const toolCallDelta: Record<string, unknown> = {
                index: blockIndex,
                function: { arguments: partial },
              };
              if (tracked && !tracked.firstDeltaEmitted) {
                toolCallDelta.id = tracked.id;
                toolCallDelta.type = "function";
                (toolCallDelta.function as Record<string, unknown>).name = tracked.name;
                tracked.firstDeltaEmitted = true;
              }
              yield {
                id: chunkId,
                object: "chat.completion.chunk",
                created,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [toolCallDelta] } as any,
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
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  private headers(cfg: ProviderConfig): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-api-key": cfg.api_key ?? "",
      "anthropic-version": "2023-06-01",
    };
  }

  private toAnthropicBody(req: ChatCompletionRequest, modelId: string): Record<string, unknown> {
    let systemPrompt: string | undefined;
    const messages: Array<{ role: string; content: string | unknown[] }> = [];

    for (const msg of req.messages) {
      if (msg.role === "system") {
        systemPrompt = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        continue;
      }

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
      max_tokens: req.max_tokens ?? 4096,
    };

    if (systemPrompt) body.system = systemPrompt;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];

    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description ?? "",
        input_schema: t.function.parameters ?? { type: "object", properties: {} },
      }));
    }

    if (req.tool_choice) {
      if (req.tool_choice === "auto") {
        body.tool_choice = { type: "auto" };
      } else if (req.tool_choice === "none") {
        body.tool_choice = { type: "none" };
      } else if (typeof req.tool_choice === "object") {
        const tc = req.tool_choice as { function?: { name?: string } };
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
}
