/**
 * for_each budget helpers.
 *
 * Extracted from dispatch-foreach.ts to keep the main dispatcher focused on
 * orchestration. Delegates to the SQL-level `events.sumHookCost(...)` so the
 * hot path never scans events in app code (see for-each-budget.test.ts which
 * pins events.list as not invoked from here).
 */

import type { DispatchDeps } from "../types.js";

const COST_HOOKS = ["SessionEnd", "StopFailure"];

/**
 * Sum the cost_usd reported in all hook_status events of type SessionEnd or
 * StopFailure for the given session (and its children, if childIds provided).
 * Returns 0 when there are no matching events.
 */
export async function sumPriorIterationCosts(
  events: Pick<DispatchDeps["events"], "sumHookCost">,
  sessionId: string,
  childIds?: string[],
): Promise<number> {
  const trackIds = [sessionId, ...(childIds ?? [])];
  return events.sumHookCost(trackIds, COST_HOOKS);
}
