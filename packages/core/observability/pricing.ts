/**
 * PricingRegistry -- universal model pricing for 300+ models.
 *
 * Loads a builtin fallback table on construction, then optionally refreshes
 * from LiteLLM's public JSON at boot (non-blocking, best-effort).
 */

export interface ModelPricing {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_per_token?: number;
  cache_write_per_token?: number;
  max_tokens?: number;
  max_input_tokens?: number;
  fastMultiplier?: number;
  webSearchCostPerRequest?: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export class PricingRegistry {
  private prices: Map<string, ModelPricing> = new Map();

  constructor() {
    this.loadDefaults();
  }

  /** Try to fetch latest prices from LiteLLM's public JSON. Returns count of models loaded. */
  async refreshFromRemote(): Promise<number> {
    try {
      const url = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
      const resp = await fetch(url);
      if (!resp.ok) return 0;
      const data = await resp.json() as Record<string, any>;
      let count = 0;
      for (const [model, info] of Object.entries(data)) {
        if (info && typeof info === "object" && info.input_cost_per_token !== undefined) {
          this.prices.set(model, {
            input_cost_per_token: info.input_cost_per_token,
            output_cost_per_token: info.output_cost_per_token ?? 0,
            cache_read_per_token: info.cache_read_input_token_cost,
            cache_write_per_token: info.cache_creation_input_token_cost,
            max_tokens: info.max_tokens,
            max_input_tokens: info.max_input_tokens,
          });
          count++;
        }
      }
      return count;
    } catch {
      return 0; // fallback to defaults
    }
  }

  /** Get pricing for a model. Tries exact match, then alias, then prefix match. */
  getPrice(model: string): ModelPricing | null {
    // Exact match
    if (this.prices.has(model)) return this.prices.get(model)!;

    // Ark model aliases (short names used in agent YAML)
    const aliases: Record<string, string> = {
      "opus": "claude-opus-4-6",
      "sonnet": "claude-sonnet-4-6",
      "haiku": "claude-haiku-4-5",
      "gpt-4.1": "gpt-4.1",
      "gpt-4.1-mini": "gpt-4.1-mini",
      "gpt-4.1-nano": "gpt-4.1-nano",
      "gemini-2.5-pro": "gemini-2.5-pro",
      "gemini-2.5-flash": "gemini-2.5-flash",
      "o4-mini": "o4-mini",
    };
    const aliased = aliases[model];
    if (aliased && this.prices.has(aliased)) return this.prices.get(aliased)!;

    // Prefix match (e.g. "claude-sonnet" matches "claude-sonnet-4-6")
    for (const [key, price] of this.prices) {
      if (key.startsWith(model) || model.startsWith(key)) return price;
    }
    return null;
  }

  /** Calculate cost in USD from token counts and model name. */
  calculateCost(model: string, usage: TokenUsage, opts?: { speed?: "standard" | "fast"; webSearchRequests?: number }): number {
    const p = this.getPrice(model);
    if (!p) return 0;
    let cost = (
      (usage.input_tokens ?? 0) * p.input_cost_per_token +
      (usage.output_tokens ?? 0) * p.output_cost_per_token +
      (usage.cache_read_tokens ?? 0) * (p.cache_read_per_token ?? p.input_cost_per_token * 0.1) +
      (usage.cache_write_tokens ?? 0) * (p.cache_write_per_token ?? p.input_cost_per_token * 1.25)
    );
    if (opts?.speed === "fast") {
      cost *= p.fastMultiplier ?? 1;
    }
    cost += (opts?.webSearchRequests ?? 0) * (p.webSearchCostPerRequest ?? 0.01);
    return cost;
  }

  /** Check if any prices are loaded. */
  get size(): number {
    return this.prices.size;
  }

  /** List all known model names. */
  listModels(): string[] {
    return [...this.prices.keys()];
  }

  private loadDefaults(): void {
    // Anthropic
    this.prices.set("claude-opus-4-6", {
      input_cost_per_token: 15 / 1e6, output_cost_per_token: 75 / 1e6,
      cache_read_per_token: 1.5 / 1e6, cache_write_per_token: 18.75 / 1e6,
      fastMultiplier: 6, webSearchCostPerRequest: 0.01,
    });
    this.prices.set("claude-sonnet-4-6", {
      input_cost_per_token: 3 / 1e6, output_cost_per_token: 15 / 1e6,
      cache_read_per_token: 0.3 / 1e6, cache_write_per_token: 3.75 / 1e6,
      webSearchCostPerRequest: 0.01,
    });
    this.prices.set("claude-haiku-4-5", {
      input_cost_per_token: 0.8 / 1e6, output_cost_per_token: 4 / 1e6,
      cache_read_per_token: 0.08 / 1e6, cache_write_per_token: 1 / 1e6,
      webSearchCostPerRequest: 0.01,
    });

    // OpenAI
    this.prices.set("gpt-4.1", {
      input_cost_per_token: 2 / 1e6, output_cost_per_token: 8 / 1e6,
      webSearchCostPerRequest: 0.01,
    });
    this.prices.set("gpt-4.1-mini", {
      input_cost_per_token: 0.4 / 1e6, output_cost_per_token: 1.6 / 1e6,
      webSearchCostPerRequest: 0.01,
    });
    this.prices.set("gpt-4.1-nano", {
      input_cost_per_token: 0.1 / 1e6, output_cost_per_token: 0.4 / 1e6,
      webSearchCostPerRequest: 0.01,
    });

    // Google
    this.prices.set("gemini-2.5-pro", {
      input_cost_per_token: 1.25 / 1e6, output_cost_per_token: 10 / 1e6,
      webSearchCostPerRequest: 0.01,
    });
    this.prices.set("gemini-2.5-flash", {
      input_cost_per_token: 0.15 / 1e6, output_cost_per_token: 0.6 / 1e6,
      webSearchCostPerRequest: 0.01,
    });

    // OpenAI reasoning
    this.prices.set("o4-mini", {
      input_cost_per_token: 1.1 / 1e6, output_cost_per_token: 4.4 / 1e6,
      webSearchCostPerRequest: 0.01,
    });
  }
}
