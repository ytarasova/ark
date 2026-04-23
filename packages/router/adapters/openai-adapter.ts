/**
 * OpenAI adapter (also used as the default for OpenAI-compatible providers:
 * vLLM, Ollama, TensorZero's /openai/v1, etc.). Passthrough -- the Router
 * request shape already matches OpenAI's Chat Completions API.
 */

import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, ProviderConfig } from "../types.js";
import { type AdapterRequest, type ProviderAdapter, stripRouting } from "./provider-adapter.js";

export class OpenAIAdapter implements ProviderAdapter {
  readonly name = "openai";

  toRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest {
    const body = { ...stripRouting(req), model: modelId, stream: false };
    return {
      url: `${cfg.base_url}/v1/chat/completions`,
      init: { method: "POST", headers: this.headers(cfg), body: JSON.stringify(body) },
    };
  }

  toStreamRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest {
    const body = { ...stripRouting(req), model: modelId, stream: true };
    return {
      url: `${cfg.base_url}/v1/chat/completions`,
      init: { method: "POST", headers: this.headers(cfg), body: JSON.stringify(body) },
    };
  }

  async fromResponse(resp: Response, _modelId: string): Promise<ChatCompletionResponse> {
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${text}`);
    }
    return (await resp.json()) as ChatCompletionResponse;
  }

  async *streamChunks(resp: Response, _modelId: string): AsyncGenerator<ChatCompletionChunk> {
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI streaming error ${resp.status}: ${text}`);
    }
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

  private headers(cfg: ProviderConfig): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.api_key}`,
    };
  }
}
