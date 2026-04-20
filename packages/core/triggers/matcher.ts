/**
 * Trigger matcher -- given a normalized event and a list of trigger configs,
 * return the configs whose source + event + match-filter all fit.
 *
 * Match semantics:
 *   - `source` must equal event.source (always required)
 *   - `event` must equal event.event OR be missing/empty (wildcard)
 *   - each `match` entry (dotted-key -> scalar) must equal the value at
 *     that path under the event root (see normalizer.evalJsonPath)
 *   - `enabled === false` excludes the config
 */

import type { NormalizedEvent, TriggerConfig, TriggerMatcher } from "./types.js";
import { evalJsonPath } from "./normalizer.js";

export class DefaultTriggerMatcher implements TriggerMatcher {
  match(event: NormalizedEvent, configs: TriggerConfig[]): TriggerConfig[] {
    return configs.filter((cfg) => this.matches(event, cfg));
  }

  private matches(event: NormalizedEvent, cfg: TriggerConfig): boolean {
    if (cfg.enabled === false) return false;
    if (cfg.source !== event.source) return false;
    if (cfg.event && cfg.event !== event.event) return false;
    if (cfg.match) {
      for (const [key, expected] of Object.entries(cfg.match)) {
        const path = key.startsWith("$") ? key : `$.payload.${key}`;
        const actual = evalJsonPath(path, event);
        if (!scalarEquals(actual, expected)) return false;
      }
    }
    return true;
  }
}

function scalarEquals(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (typeof expected === "number" && typeof actual === "string") {
    return Number(actual) === expected;
  }
  if (typeof expected === "boolean" && typeof actual === "string") {
    return (actual === "true") === expected;
  }
  return false;
}

/** Shared default instance so callers don't have to construct one. */
export const defaultMatcher: TriggerMatcher = new DefaultTriggerMatcher();
