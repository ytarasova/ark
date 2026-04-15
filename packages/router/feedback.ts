/**
 * LLM Router -- feedback tracker.
 *
 * Logs routing decisions, tracks per-model quality scores, and provides
 * cost attribution. In-memory for v1 -- no persistence.
 */

import type {
  ChatCompletionResponse,
  RoutingDecision,
  CostEntry,
  CostSummary,
  RouterStats,
  ModelConfig,
} from "./types.js";

export class FeedbackTracker {
  private decisions: DecisionRecord[] = [];
  private modelQuality = new Map<string, QualityTracker>();
  private costs: CostEntry[] = [];
  private stats: MutableStats;

  constructor() {
    this.stats = {
      total_requests: 0,
      routed_requests: 0,
      passthrough_requests: 0,
      requests_by_model: {},
      requests_by_provider: {},
      requests_by_tier: {},
      total_classification_ms: 0,
      total_routing_ms: 0,
      total_cost_usd: 0,
      errors: 0,
      fallbacks: 0,
      started_at: Date.now(),
    };
  }

  /** Log a successful routing decision + response. */
  logDecision(decision: RoutingDecision, response: ChatCompletionResponse, model?: ModelConfig): void {
    this.stats.total_requests++;
    this.stats.routed_requests++;
    this.stats.requests_by_model[decision.selected_model] =
      (this.stats.requests_by_model[decision.selected_model] ?? 0) + 1;
    this.stats.requests_by_provider[decision.selected_provider] =
      (this.stats.requests_by_provider[decision.selected_provider] ?? 0) + 1;

    if (model) {
      this.stats.requests_by_tier[model.tier] = (this.stats.requests_by_tier[model.tier] ?? 0) + 1;
    }

    this.stats.total_classification_ms += decision.latency_ms.classification;
    this.stats.total_routing_ms += decision.latency_ms.routing;

    // Calculate cost
    if (response.usage && model) {
      const inputCost = (response.usage.prompt_tokens / 1_000_000) * model.cost_input;
      const outputCost = (response.usage.completion_tokens / 1_000_000) * model.cost_output;
      const totalCost = inputCost + outputCost;

      const entry: CostEntry = {
        model: decision.selected_model,
        provider: decision.selected_provider,
        input_tokens: response.usage.prompt_tokens,
        output_tokens: response.usage.completion_tokens,
        cost_usd: totalCost,
        timestamp: Date.now(),
        session_id: decision.complexity.task_type, // use task type as pseudo-session
      };
      this.costs.push(entry);
      this.stats.total_cost_usd += totalCost;
    }

    // Update quality tracker
    this.getOrCreateQuality(decision.selected_model).recordSuccess();

    // Store decision record (keep last 10000)
    this.decisions.push({
      decision,
      model: response.model,
      usage: response.usage,
      timestamp: Date.now(),
    });
    if (this.decisions.length > 10000) {
      this.decisions = this.decisions.slice(-5000);
    }
  }

  /** Log a passthrough request (specific model, no routing). */
  logPassthrough(model: string, provider: string): void {
    this.stats.total_requests++;
    this.stats.passthrough_requests++;
    this.stats.requests_by_model[model] = (this.stats.requests_by_model[model] ?? 0) + 1;
    this.stats.requests_by_provider[provider] = (this.stats.requests_by_provider[provider] ?? 0) + 1;
  }

  /** Log a failure for a model. */
  logFailure(model: string, reason: string): void {
    this.stats.errors++;
    this.getOrCreateQuality(model).recordFailure(reason);
  }

  /** Log a fallback event. */
  logFallback(): void {
    this.stats.fallbacks++;
  }

  /** Get the current quality score for a model (0-1). */
  getModelQuality(model: string): number {
    return this.getOrCreateQuality(model).score();
  }

  /** Get cost summary, optionally grouped. */
  getCostSummary(opts?: { since?: Date; groupBy?: "model" | "provider" | "session" }): CostSummary[] {
    const groupBy = opts?.groupBy ?? "model";
    const since = opts?.since?.getTime() ?? 0;

    const filtered = this.costs.filter((c) => c.timestamp >= since);
    const groups = new Map<string, CostSummary>();

    for (const c of filtered) {
      const key = groupBy === "model" ? c.model : groupBy === "provider" ? c.provider : (c.session_id ?? "unknown");

      const existing = groups.get(key) ?? {
        key,
        total_cost_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        request_count: 0,
      };

      existing.total_cost_usd += c.cost_usd;
      existing.total_input_tokens += c.input_tokens;
      existing.total_output_tokens += c.output_tokens;
      existing.request_count++;

      groups.set(key, existing);
    }

    return Array.from(groups.values()).sort((a, b) => b.total_cost_usd - a.total_cost_usd);
  }

  /** Get overall router stats. */
  getStats(): RouterStats {
    const totalRequests = this.stats.total_requests || 1;
    return {
      total_requests: this.stats.total_requests,
      routed_requests: this.stats.routed_requests,
      passthrough_requests: this.stats.passthrough_requests,
      requests_by_model: { ...this.stats.requests_by_model },
      requests_by_provider: { ...this.stats.requests_by_provider },
      requests_by_tier: { ...this.stats.requests_by_tier },
      avg_classification_ms: this.stats.total_classification_ms / totalRequests,
      avg_routing_ms: this.stats.total_routing_ms / totalRequests,
      total_cost_usd: this.stats.total_cost_usd,
      uptime_ms: Date.now() - this.stats.started_at,
      started_at: this.stats.started_at,
      errors: this.stats.errors,
      fallbacks: this.stats.fallbacks,
    };
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private getOrCreateQuality(model: string): QualityTracker {
    let qt = this.modelQuality.get(model);
    if (!qt) {
      qt = new QualityTracker();
      this.modelQuality.set(model, qt);
    }
    return qt;
  }
}

// ── Quality tracker per model ────────────────────────────────────────────────

class QualityTracker {
  private successes = 0;
  private failures = 0;
  private recentFailures: string[] = [];

  recordSuccess(): void {
    this.successes++;
  }

  recordFailure(reason: string): void {
    this.failures++;
    this.recentFailures.push(reason);
    if (this.recentFailures.length > 100) {
      this.recentFailures = this.recentFailures.slice(-50);
    }
  }

  /** Quality score 0-1, based on success rate with a Bayesian prior. */
  score(): number {
    const total = this.successes + this.failures;
    if (total === 0) return 0.9; // optimistic prior
    // Beta distribution mean with alpha=successes+1, beta=failures+1
    return (this.successes + 1) / (total + 2);
  }
}

// ── Internal types ───────────────────────────────────────────────────────────

interface DecisionRecord {
  decision: RoutingDecision;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  timestamp: number;
}

interface MutableStats {
  total_requests: number;
  routed_requests: number;
  passthrough_requests: number;
  requests_by_model: Record<string, number>;
  requests_by_provider: Record<string, number>;
  requests_by_tier: Record<string, number>;
  total_classification_ms: number;
  total_routing_ms: number;
  total_cost_usd: number;
  errors: number;
  fallbacks: number;
  started_at: number;
}
