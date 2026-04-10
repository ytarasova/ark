/**
 * LLM Router -- dispatcher.
 *
 * Dispatches requests to the selected provider with:
 * - Fallback on provider failure (try next provider with same tier)
 * - Circuit breaker awareness
 * - Cascade mode (try cheap first, escalate if low confidence)
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  RoutingDecision,
  ModelConfig,
} from "./types.js";
import type { ProviderRegistry } from "./providers.js";

export class Dispatcher {
  constructor(private registry: ProviderRegistry) {}

  /**
   * Dispatch a non-streaming request with fallback.
   * If the selected provider fails, tries another provider in the same tier.
   */
  async dispatch(
    request: ChatCompletionRequest,
    decision: RoutingDecision,
  ): Promise<ChatCompletionResponse> {
    const { selected_model, selected_provider } = decision;

    // Try primary provider
    const primary = this.registry.getProvider(selected_provider);
    if (primary && !primary.breaker.isOpen()) {
      try {
        return await primary.complete(request, selected_model);
      } catch (err) {
        console.error(`[router] Primary dispatch failed (${selected_provider}/${selected_model}): ${(err as Error).message}`);
      }
    }

    // Fallback: try other providers with models in the same tier
    const selectedModel = this.registry.findModel(selected_model);
    const tier = selectedModel?.tier ?? "standard";

    const fallbackModels = this.registry.listModels()
      .filter(m => m.tier === tier && m.id !== selected_model)
      .sort((a, b) => a.quality - b.quality); // prefer lower quality first for cost

    for (const fallbackModel of fallbackModels) {
      const provider = this.registry.findProviderForModel(fallbackModel.id);
      if (!provider || provider.breaker.isOpen()) continue;

      try {
        console.error(`[router] Falling back to ${fallbackModel.provider}/${fallbackModel.id}`);
        const response = await provider.complete(request, fallbackModel.id);
        // Update the response model to reflect actual model used
        response.model = fallbackModel.id;
        return response;
      } catch (err) {
        console.error(`[router] Fallback ${fallbackModel.provider}/${fallbackModel.id} failed: ${(err as Error).message}`);
      }
    }

    // All providers failed
    throw new Error(`All providers failed for tier '${tier}'. Check API keys and provider status.`);
  }

  /**
   * Dispatch a streaming request with fallback.
   * Returns an async generator of chunks.
   */
  async *dispatchStream(
    request: ChatCompletionRequest,
    decision: RoutingDecision,
  ): AsyncGenerator<ChatCompletionChunk> {
    const { selected_model, selected_provider } = decision;

    // Try primary provider
    const primary = this.registry.getProvider(selected_provider);
    if (primary && !primary.breaker.isOpen()) {
      try {
        yield* primary.stream(request, selected_model);
        return;
      } catch (err) {
        console.error(`[router] Primary stream failed (${selected_provider}/${selected_model}): ${(err as Error).message}`);
      }
    }

    // Fallback: try other providers with models in same tier
    const selectedModel = this.registry.findModel(selected_model);
    const tier = selectedModel?.tier ?? "standard";

    const fallbackModels = this.registry.listModels()
      .filter(m => m.tier === tier && m.id !== selected_model)
      .sort((a, b) => a.quality - b.quality);

    for (const fallbackModel of fallbackModels) {
      const provider = this.registry.findProviderForModel(fallbackModel.id);
      if (!provider || provider.breaker.isOpen()) continue;

      try {
        console.error(`[router] Stream fallback to ${fallbackModel.provider}/${fallbackModel.id}`);
        yield* provider.stream(request, fallbackModel.id);
        return;
      } catch (err) {
        console.error(`[router] Stream fallback ${fallbackModel.provider}/${fallbackModel.id} failed: ${(err as Error).message}`);
      }
    }

    throw new Error(`All stream providers failed for tier '${tier}'.`);
  }

  /**
   * Cascade mode: try cheapest model first, escalate if confidence seems low.
   *
   * This checks the response for signs of low confidence:
   * - Very short response for a complex question
   * - Response contains hedging language
   * - Tool calls failed or were incomplete
   *
   * If low confidence detected and a higher-tier model is available, retries
   * with that model.
   */
  async cascade(
    request: ChatCompletionRequest,
    models: ModelConfig[],
    confidenceThreshold: number,
  ): Promise<ChatCompletionResponse & { cascaded?: boolean }> {
    // Sort models by cost (cheapest first)
    const sorted = [...models].sort((a, b) => {
      return (a.cost_input + a.cost_output) - (b.cost_input + b.cost_output);
    });

    for (let i = 0; i < sorted.length; i++) {
      const model = sorted[i];
      const provider = this.registry.findProviderForModel(model.id);
      if (!provider || provider.breaker.isOpen()) continue;

      try {
        const response = await provider.complete(request, model.id);

        // If this is the last (most expensive) model, accept the response
        if (i === sorted.length - 1) {
          return response;
        }

        // Check response confidence
        const confidence = assessConfidence(response);
        if (confidence >= confidenceThreshold) {
          return response;
        }

        // Low confidence -- escalate to next model
        console.error(`[router] Cascade: ${model.id} confidence=${confidence.toFixed(2)} < ${confidenceThreshold}, escalating`);
        continue;
      } catch (err) {
        console.error(`[router] Cascade: ${model.id} failed: ${(err as Error).message}`);
        continue;
      }
    }

    throw new Error("Cascade: all models failed or returned low confidence.");
  }
}

// ── Confidence assessment ────────────────────────────────────────────────────

const HEDGING_PATTERNS = [
  /\bI'm not sure\b/i,
  /\bI don't know\b/i,
  /\bI cannot\b/i,
  /\bI'm unable\b/i,
  /\bI think\b/i,
  /\bperhaps\b/i,
  /\bmaybe\b/i,
  /\bpossibly\b/i,
  /\bmight be\b/i,
  /\bcould be\b/i,
];

function assessConfidence(response: ChatCompletionResponse): number {
  const content = response.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") return 0.5;

  let confidence = 0.8; // base confidence

  // Very short responses for complex queries suggest low confidence
  if (content.length < 50) confidence -= 0.2;
  if (content.length < 20) confidence -= 0.2;

  // Check for hedging language
  let hedgeCount = 0;
  for (const pat of HEDGING_PATTERNS) {
    if (pat.test(content)) hedgeCount++;
  }
  confidence -= hedgeCount * 0.05;

  // Tool call failures
  const toolCalls = response.choices?.[0]?.message?.tool_calls;
  if (toolCalls?.length) {
    // Tool calls present = model is being useful
    confidence += 0.1;
  }

  // Finish reason "length" means truncated = possibly incomplete
  if (response.choices?.[0]?.finish_reason === "length") {
    confidence -= 0.15;
  }

  return Math.max(0, Math.min(1, confidence));
}
