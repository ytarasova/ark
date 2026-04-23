/**
 * Cost policy: always pick the cheapest model. Upgrade to standard if tools
 * are required (tool support on economy tier is unreliable).
 */

import type { ModelConfig, RouterConfig } from "../types.js";
import type { ClassificationResult } from "../classifier.js";
import { cheapest, type PolicySelector } from "./policy-selector.js";

export class CostPolicy implements PolicySelector {
  readonly name = "cost";

  select(candidates: ModelConfig[], classification: ClassificationResult, _cfg: RouterConfig): ModelConfig {
    const economy = candidates.filter((m) => m.tier === "economy");
    if (economy.length > 0 && !classification.has_tools) {
      return cheapest(economy);
    }
    const standardOrBelow = candidates.filter((m) => m.tier === "standard" || m.tier === "economy");
    if (standardOrBelow.length > 0) {
      return cheapest(standardOrBelow);
    }
    return cheapest(candidates);
  }

  skipReason(model: ModelConfig, selected: ModelConfig, _cfg: RouterConfig): string | null {
    const sCost = selected.cost_input + selected.cost_output;
    const mCost = model.cost_input + model.cost_output;
    if (mCost > sCost) return "higher_cost";
    return null;
  }
}
