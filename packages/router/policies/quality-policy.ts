/**
 * Quality policy: always pick the highest-quality model.
 */

import type { ModelConfig, RouterConfig } from "../types.js";
import type { ClassificationResult } from "../classifier.js";
import { highestQuality, type PolicySelector } from "./policy-selector.js";

export class QualityPolicy implements PolicySelector {
  readonly name = "quality";

  select(candidates: ModelConfig[], _classification: ClassificationResult, _cfg: RouterConfig): ModelConfig {
    return highestQuality(candidates);
  }

  skipReason(model: ModelConfig, selected: ModelConfig, _cfg: RouterConfig): string | null {
    if (model.quality < selected.quality) return "lower_quality";
    return null;
  }
}
