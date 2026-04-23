/**
 * LLM Router -- policies barrel export.
 *
 * `defaultPolicyRegistry()` returns a fresh registry populated with the three
 * shipped policies. Callers can further `register()` custom policies onto it.
 */

import { PolicyRegistry } from "./policy-selector.js";
import { QualityPolicy } from "./quality-policy.js";
import { CostPolicy } from "./cost-policy.js";
import { BalancedPolicy } from "./balanced-policy.js";

export { PolicyRegistry, cheapest, highestQuality, type PolicySelector } from "./policy-selector.js";
export { TierEscalator, defaultTierEscalator, type Tier } from "./tier-escalator.js";
export { QualityPolicy } from "./quality-policy.js";
export { CostPolicy } from "./cost-policy.js";
export { BalancedPolicy } from "./balanced-policy.js";

/** Build a fresh registry pre-populated with the three shipped policies. */
export function defaultPolicyRegistry(): PolicyRegistry {
  const registry = new PolicyRegistry();
  registry.register(new QualityPolicy());
  registry.register(new CostPolicy());
  registry.register(new BalancedPolicy());
  return registry;
}
