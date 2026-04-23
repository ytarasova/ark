/**
 * Google Gemini adapter. Converts OpenAI-format requests to Gemini's
 * generateContent / streamGenerateContent APIs and normalises responses.
 */

import type { ChatCompletionRequest, ChatCompletionResponse, ChatCompletionChunk, ProviderConfig } from "../types.js";
import type { AdapterRequest, ProviderAdapter } from "./provider-adapter.js";

export class GoogleAdapter implements ProviderAdapter {
  readonly name = "google";

  toRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest {
    const url = `${cfg.base_url}/v1beta/models/${modelId}:generateContent?key=${cfg.api_key}`;
    return {
      url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.toGeminiBody(req)),
      },
    };
  }

  toStreamRequest(req: ChatCompletionRequest, modelId: string, cfg: ProviderConfig): AdapterRequest {
    const url = `${cfg.base_url}/v1beta/models/${modelId}:streamGenerateContent?key=${cfg.api_key}&alt=sse`;
    return {
      url,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.toGeminiBody(req)),
      },
    };
  }

  async fromResponse(resp: Response, modelId: string): Promise<ChatCompletionResponse> {
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Google API error ${resp.status}: ${text}`);
    }
    const raw = await resp.json();
    return this.fromGeminiResponse(raw, modelId);
  }

  async *streamChunks(resp: Response, modelId: string): AsyncGenerator<ChatCompletionChunk> {
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  private toGeminiBody(req: ChatCompletionRequest): Record<string, unknown> {
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;

    for (const msg of req.messages) {
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
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
    if (req.top_p !== undefined) generationConfig.topP = req.top_p;
    if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
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
}
