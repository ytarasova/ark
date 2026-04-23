/**
 * LLM Router -- tier escalation ladder.
 *
 * Replaces the `switch (tier)` anti-pattern in the engine with a typed
 * ladder. Extending the tier set only requires editing the map here;
 * the balanced policy selector reads it verbatim.
 */

export type Tier = "economy" | "standard" | "frontier";

/**
 * Declarative ladder of escalation tiers. The entry for tier `T` is the
 * ordered list of tiers to try when `T` has no qualifying models.
 */
const ESCALATION: Record<Tier, Tier[]> = {
  economy: ["standard", "frontier"],
  standard: ["frontier"],
  frontier: [],
};

export class TierEscalator {
  /** Return the tiers to try above `tier`, in order. Empty if `tier` is the top. */
  higherTiers(tier: string): Tier[] {
    if (tier in ESCALATION) {
      return ESCALATION[tier as Tier];
    }
    return [];
  }
}

/** Shared instance. Stateless. */
export const defaultTierEscalator = new TierEscalator();
