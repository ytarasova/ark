/**
 * SystemClock adapter -- stub.
 *
 * In Slice 3 this will delegate to `Date.now()` / `new Date().toISOString()`.
 */

import type { Clock } from "../../ports/clock.js";

const NOT_MIGRATED = new Error("SystemClock: not migrated yet -- Slice 3");

export class SystemClock implements Clock {
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
