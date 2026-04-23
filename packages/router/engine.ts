/**
 * LLM Router -- routing engine.
 *
 * Makes model selection decisions based on classifier output and policy.
 *
 * Policies are pluggable (see `policies/`):
 * - "quality": always pick the highest-quality model
 * - "balanced": pick the cheapest model that meets the quality floor
 * - "cost": always pick the cheapest model
 * - <custom>: callers can register their own `PolicySelector`
 *
 * Supports sticky sessions (keep same model for a conversation) with
 * escalation triggers when complexity spikes mid-conversation.
 */

import type { ChatCompletionRequest, RoutingDecision, ModelConfig, RouterConfig } from "./types.js";
import type { ClassificationResult } from "./classifier.js";
import type { ProviderRegistry } from "./providers.js";
import { defaultPolicyRegistry, type PolicyRegistry, type PolicySelector } from "./policies/index.js";

// ── Sticky session entry ─────────────────────────────────────────────────────

interface StickyEntry {
  model: string;
  provider: string;
  last_score: number;
  created_at: number;
}

/** Optional constructor overrides. */
export interface RoutingEngineOptions {
  /** Custom policy registry. Defaults to the three shipped policies. */
  policies?: PolicyRegistry;
}

// ── Routing Engine ───────────────────────────────────────────────────────────

export class RoutingEngine {
  private stickySessions = new Map<string, StickyEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private readonly policies: PolicyRegistry;

  constructor(
    private registry: ProviderRegistry,
    private config: RouterConfig,
    opts?: RoutingEngineOptions,
  ) {
    this.policies = opts?.policies ?? defaultPolicyRegistry();
    // Periodic cleanup of expired sticky sessions
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 60_000);
  }

  /**
   * Register a custom policy selector. Subsequent routes can reference it by
   * its `name`, e.g. `request.routing.policy = "latency-aware-v2"`.
   */
  registerPolicy(selector: PolicySelector): void {
    this.policies.register(selector);
  }

  /** Stop the cleanup timer. */
  stop(): void {
    clearInterval(this.cleanupTimer);
  }

  /** Make a routing decision for a request. */
  route(request: ChatCompletionRequest, classification: ClassificationResult): RoutingDecision {
    const t0 = performance.now();
    const policyName = request.routing?.policy ?? this.config.policy;
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
    let candidates = this.registry.listModels().filter((m) => {
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
      candidates = this.registry.listModels().filter((m) => {
        const provider = this.registry.findProviderForModel(m.id);
        return !provider?.breaker.isOpen();
      });
    }

    // Resolve selector and delegate. Unknown policies fall back to the config's
    // declared default rather than failing; this preserves legacy switch-default
    // behaviour where "balanced" was the catch-all.
    const selector = this.policies.resolve(policyName, this.config.policy);
    const effectiveCfg: RouterConfig = { ...this.config, quality_floor: qualityFloor };
    const selected = selector.select(candidates, classification, effectiveCfg);
    const alternatives = candidates
      .filter((m) => m.id !== selected.id)
      .slice(0, 5)
      .map((m) => ({
        model: m.id,
        reason_skipped: this.skipReason(selector, m, selected, effectiveCfg),
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
      reason: `policy:${selector.name}, complexity:${classification.difficulty}, tier:${selected.tier}`,
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

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Compose a skip reason by asking the selector first; fall back to generic
   * rules when the selector doesn't have a policy-specific explanation.
   */
  private skipReason(selector: PolicySelector, model: ModelConfig, selected: ModelConfig, cfg: RouterConfig): string {
    const reason = selector.skipReason(model, selected, cfg);
    if (reason) return reason;
    if (model.quality < cfg.quality_floor) return "below_quality_floor";
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
