/**
 * MockClock adapter -- stub.
 *
 * Slice 3: settable `now` and `sleep` resolves immediately (or after a
 * scheduler `tick()`), enabling time-sensitive tests without real delays.
 */

import type { Clock } from "../../ports/clock.js";

const NOT_MIGRATED = new Error("MockClock: not migrated yet -- Slice 3");

export class MockClock implements Clock {
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
