/**
 * Balanced policy: pick the cheapest model meeting the quality floor,
 * with target-tier selection driven by the classification score.
 *
 * Falls back through the TierEscalator ladder when the target tier has no
 * qualifying models, and finally to highest-quality regardless of floor.
 */

import type { ModelConfig, RouterConfig } from "../types.js";
import type { ClassificationResult } from "../classifier.js";
import { cheapest, highestQuality, type PolicySelector } from "./policy-selector.js";
import { defaultTierEscalator, type Tier, type TierEscalator } from "./tier-escalator.js";

export class BalancedPolicy implements PolicySelector {
  readonly name = "balanced";

  constructor(private escalator: TierEscalator = defaultTierEscalator) {}

  select(candidates: ModelConfig[], classification: ClassificationResult, cfg: RouterConfig): ModelConfig {
    const targetTier = pickTargetTier(classification.score);
    const meetsFloor = candidates.filter((m) => m.quality >= cfg.quality_floor);
    const inTier = meetsFloor.filter((m) => m.tier === targetTier);

    if (inTier.length > 0) {
      return cheapest(inTier);
    }

    for (const tier of this.escalator.higherTiers(targetTier)) {
      const upgraded = meetsFloor.filter((m) => m.tier === tier);
      if (upgraded.length > 0) {
        return cheapest(upgraded);
      }
    }

    if (meetsFloor.length > 0) {
      return cheapest(meetsFloor);
    }

    return highestQuality(candidates);
  }

  skipReason(model: ModelConfig, selected: ModelConfig, cfg: RouterConfig): string | null {
    if (model.quality < cfg.quality_floor) return "below_quality_floor";
    const sCost = selected.cost_input + selected.cost_output;
    const mCost = model.cost_input + model.cost_output;
    if (mCost > sCost) return "cost_exceeds_policy";
    return null;
  }
}

function pickTargetTier(score: number): Tier {
  if (score < 0.3) return "economy";
  if (score < 0.7) return "standard";
  return "frontier";
}
