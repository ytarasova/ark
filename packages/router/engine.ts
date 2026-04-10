/**
 * LLM Router -- routing engine.
 *
 * Makes model selection decisions based on classifier output and policy.
 *
 * Three policies:
 * - quality: always pick the highest-quality model
 * - balanced: pick the cheapest model that meets the quality floor
 * - cost: always pick the cheapest model
 *
 * Supports sticky sessions (keep same model for a conversation) with
 * escalation triggers when complexity spikes mid-conversation.
 */

import type { ChatCompletionRequest, RoutingDecision, ModelConfig, RouterConfig, RoutingPolicy } from "./types.js";
import type { ClassificationResult } from "./classifier.js";
import type { ProviderRegistry } from "./providers.js";

// ── Sticky session entry ─────────────────────────────────────────────────────

interface StickyEntry {
  model: string;
  provider: string;
  last_score: number;
  created_at: number;
}

// ── Routing Engine ───────────────────────────────────────────────────────────

export class RoutingEngine {
  private stickySessions = new Map<string, StickyEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private registry: ProviderRegistry,
    private config: RouterConfig,
  ) {
    // Periodic cleanup of expired sticky sessions
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
  }

  /** Stop the cleanup timer. */
  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  /** Make a routing decision for a request. */
  route(
    request: ChatCompletionRequest,
    classification: ClassificationResult,
  ): RoutingDecision {
    const t0 = performance.now();
    const policy = request.routing?.policy ?? this.config.policy;
    const qualityFloor = request.routing?.quality_floor ?? this.config.quality_floor;
    const stickyId = request.routing?.sticky_session_id;
    const preferredProviders = request.routing?.preferred_providers;
    const excludedModels = new Set(request.routing?.excluded_models ?? []);

    // Check sticky session
    if (stickyId) {
      const sticky = this.stickySessions.get(stickyId);
      if (sticky) {
        // Check for escalation trigger: complexity spike > 0.3
        const scoreDelta = classification.score - sticky.last_score;
        if (scoreDelta <= 0.3) {
          // Stick with current model
          const routingMs = performance.now() - t0;
          return {
            selected_model: sticky.model,
            selected_provider: sticky.provider,
            reason: `sticky_session (delta=${scoreDelta.toFixed(2)})`,
            alternatives_considered: [],
            latency_ms: {
              classification: 0, // filled by caller
              routing: routingMs,
              total_overhead: routingMs,
            },
            complexity: {
              score: classification.score,
              task_type: classification.task_type,
              has_tools: classification.has_tools,
              estimated_difficulty: classification.difficulty,
            },
          };
        }
        // Complexity spiked -- re-route (escalation)
      }
    }

    // Get eligible models
    let candidates = this.registry.listModels().filter(m => {
      if (excludedModels.has(m.id)) return false;
      if (preferredProviders?.length && !preferredProviders.includes(m.provider)) return false;
      if (classification.has_tools && !m.supports_tools) return false;
      // Check circuit breaker
      const provider = this.registry.findProviderForModel(m.id);
      if (provider?.breaker.isOpen()) return false;
      return true;
    });

    if (candidates.length === 0) {
      // Fallback: use all models (ignore filters)
      candidates = this.registry.listModels().filter(m => {
        const provider = this.registry.findProviderForModel(m.id);
        return !provider?.breaker.isOpen();
      });
    }

    // Select model based on policy
    const selected = this.selectByPolicy(policy, candidates, classification, qualityFloor);
    const alternatives = candidates
      .filter(m => m.id !== selected.id)
      .slice(0, 5)
      .map(m => ({
        model: m.id,
        reason_skipped: this.skipReason(m, selected, policy, qualityFloor),
      }));

    // Update sticky session
    if (stickyId) {
      this.stickySessions.set(stickyId, {
        model: selected.id,
        provider: selected.provider,
        last_score: classification.score,
        created_at: Date.now(),
      });
    }

    const routingMs = performance.now() - t0;

    return {
      selected_model: selected.id,
      selected_provider: selected.provider,
      reason: `policy:${policy}, complexity:${classification.difficulty}, tier:${selected.tier}`,
      alternatives_considered: alternatives,
      latency_ms: {
        classification: 0, // filled by caller
        routing: routingMs,
        total_overhead: routingMs,
      },
      complexity: {
        score: classification.score,
        task_type: classification.task_type,
        has_tools: classification.has_tools,
        estimated_difficulty: classification.difficulty,
      },
    };
  }

  // ── Policy selectors ───────────────────────────────────────────────────────

  private selectByPolicy(
    policy: RoutingPolicy,
    candidates: ModelConfig[],
    classification: ClassificationResult,
    qualityFloor: number,
  ): ModelConfig {
    switch (policy) {
      case "quality":
        return this.selectQuality(candidates);
      case "cost":
        return this.selectCost(candidates, classification);
      case "balanced":
      default:
        return this.selectBalanced(candidates, classification, qualityFloor);
    }
  }

  /** Quality policy: always pick highest quality. */
  private selectQuality(candidates: ModelConfig[]): ModelConfig {
    return candidates.reduce((best, m) => m.quality > best.quality ? m : best, candidates[0]);
  }

  /** Cost policy: always pick cheapest. Upgrade to standard if tools needed. */
  private selectCost(candidates: ModelConfig[], classification: ClassificationResult): ModelConfig {
    const economy = candidates.filter(m => m.tier === "economy");
    if (economy.length > 0 && !classification.has_tools) {
      return this.cheapest(economy);
    }
    // If tools needed, prefer standard tier (better tool support)
    const standard = candidates.filter(m => m.tier === "standard" || m.tier === "economy");
    if (standard.length > 0) {
      return this.cheapest(standard);
    }
    return this.cheapest(candidates);
  }

  /**
   * Balanced policy: pick cheapest model meeting the quality floor,
   * with tier selection based on complexity score.
   */
  private selectBalanced(
    candidates: ModelConfig[],
    classification: ClassificationResult,
    qualityFloor: number,
  ): ModelConfig {
    // Determine target tier based on complexity
    let targetTier: "economy" | "standard" | "frontier";
    if (classification.score < 0.3) {
      targetTier = "economy";
    } else if (classification.score < 0.7) {
      targetTier = "standard";
    } else {
      targetTier = "frontier";
    }

    // Filter by quality floor and target tier
    const meetsFloor = candidates.filter(m => m.quality >= qualityFloor);
    const inTier = meetsFloor.filter(m => m.tier === targetTier);

    if (inTier.length > 0) {
      return this.cheapest(inTier);
    }

    // No models in target tier meet quality floor -- try upgrading
    const higherTiers = this.higherTiers(targetTier);
    for (const tier of higherTiers) {
      const upgraded = meetsFloor.filter(m => m.tier === tier);
      if (upgraded.length > 0) {
        return this.cheapest(upgraded);
      }
    }

    // No models meet quality floor at all -- pick best available
    if (meetsFloor.length > 0) {
      return this.cheapest(meetsFloor);
    }

    // Last resort: best quality regardless of floor
    return this.selectQuality(candidates);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private cheapest(models: ModelConfig[]): ModelConfig {
    return models.reduce((best, m) => {
      const bestCost = best.cost_input + best.cost_output;
      const mCost = m.cost_input + m.cost_output;
      return mCost < bestCost ? m : best;
    }, models[0]);
  }

  private higherTiers(tier: string): string[] {
    switch (tier) {
      case "economy": return ["standard", "frontier"];
      case "standard": return ["frontier"];
      default: return [];
    }
  }

  private skipReason(model: ModelConfig, selected: ModelConfig, policy: RoutingPolicy, qualityFloor: number): string {
    if (policy === "quality" && model.quality < selected.quality) {
      return "lower_quality";
    }
    if (policy === "cost") {
      const sCost = selected.cost_input + selected.cost_output;
      const mCost = model.cost_input + model.cost_output;
      if (mCost > sCost) return "higher_cost";
    }
    if (model.quality < qualityFloor) return "below_quality_floor";
    const sCost = selected.cost_input + selected.cost_output;
    const mCost = model.cost_input + model.cost_output;
    if (mCost > sCost) return "cost_exceeds_policy";
    return "not_preferred";
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.stickySessions) {
      if (now - entry.created_at > this.config.sticky_session_ttl_ms) {
        this.stickySessions.delete(id);
      }
    }
  }
}
