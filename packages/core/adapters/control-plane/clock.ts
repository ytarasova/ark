/**
 * ControlPlaneClock adapter -- stub.
 *
 * Same as `SystemClock` for now; separate adapter so the control-plane
 * binding module doesn't reach across `../adapters/local/**` (enforced by
 * the hex ESLint boundary rule). Slice 3 migration.
 */

import type { Clock } from "../../ports/clock.js";

const NOT_MIGRATED = new Error("ControlPlaneClock: not migrated yet -- Slice 3");

export class ControlPlaneClock implements Clock {
  now(): number {
    throw NOT_MIGRATED;
  }
  iso(): string {
    throw NOT_MIGRATED;
  }
  sleep(_ms: number): Promise<void> {
    throw NOT_MIGRATED;
  }
}
