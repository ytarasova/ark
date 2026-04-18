/**
 * Clock port -- abstracts wall-clock time.
 *
 * Lets tests inject a frozen / fast-forward clock instead of sleeping.
 *
 * Local + control-plane binding: `SystemClock` (delegates to `Date`).
 * Test binding: `MockClock` with a settable `now` value.
 */

export interface Clock {
  /** Epoch milliseconds (same as `Date.now()`). */
  now(): number;

  /** ISO-8601 string for the current instant. */
  iso(): string;

  /**
   * Resolve a promise after the given milliseconds. Lets tests stub out
   * waits via a `MockClock` without blocking the event loop.
   */
  sleep(ms: number): Promise<void>;
}
