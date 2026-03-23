/**
 * Shared async utilities for the compute layer.
 */

/** Async delay using Bun.sleep (native) with setTimeout fallback */
export const sleep = (ms: number): Promise<void> =>
  typeof Bun !== "undefined" ? Bun.sleep(ms) : new Promise<void>(r => setTimeout(r, ms));

/** Options for retry */
export interface RetryOpts {
  /** Maximum number of attempts (default: 10) */
  maxAttempts?: number;
  /** Delay between attempts in ms (default: 5000) */
  delayMs?: number;
  /** Called on each failed attempt with attempt number and error */
  onRetry?: (attempt: number, error?: unknown) => void;
  /** Called on each attempt before the action runs */
  onAttempt?: (attempt: number) => void;
  /** Abort signal to cancel the retry loop */
  signal?: AbortSignal;
}

/**
 * Retry an async action until it succeeds or max attempts reached.
 * Returns the result on success, null on exhaustion.
 */
export async function retry<T>(
  action: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T | null> {
  const { maxAttempts = 10, delayMs = 5000, onRetry, onAttempt, signal } = opts;

  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) return null;
    onAttempt?.(i + 1);

    try {
      return await action();
    } catch (e) {
      onRetry?.(i + 1, e);
      if (i < maxAttempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  return null;
}

/**
 * Poll a condition until it returns true or max attempts reached.
 */
export async function poll(
  check: () => Promise<boolean> | boolean,
  opts: RetryOpts = {},
): Promise<boolean> {
  const { maxAttempts = 30, delayMs = 5000, onRetry, onAttempt, signal } = opts;

  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) return false;
    onAttempt?.(i + 1);

    try {
      if (await check()) return true;
    } catch (e) {
      onRetry?.(i + 1, e);
    }

    if (i < maxAttempts - 1) {
      await sleep(delayMs);
    }
  }
  return false;
}
