/**
 * Shared async utilities for the compute layer.
 *
 * retry() and poll() delegate to p-retry and p-wait-for respectively,
 * while preserving the same call-site interface.
 */

import pRetry from "p-retry";
import pWaitFor from "p-wait-for";

/** Async delay using Bun.sleep (native) with setTimeout fallback */
export const sleep = (ms: number): Promise<void> =>
  typeof Bun !== "undefined" ? Bun.sleep(ms) : new Promise<void>(r => setTimeout(r, ms));

/** Options for retry / poll */
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
  try {
    return await pRetry(
      (attemptNumber) => {
        opts.onAttempt?.(attemptNumber);
        return action();
      },
      {
        retries: (opts.maxAttempts ?? 10) - 1,
        minTimeout: opts.delayMs ?? 5000,
        maxTimeout: opts.delayMs ?? 5000,
        signal: opts.signal,
        onFailedAttempt: (error) => {
          opts.onRetry?.(error.attemptNumber, error);
        },
      },
    );
  } catch {
    return null;
  }
}

/**
 * Poll a condition until it returns true or timeout.
 */
export async function poll(
  check: () => Promise<boolean> | boolean,
  opts: RetryOpts = {},
): Promise<boolean> {
  try {
    await pWaitFor(check, {
      interval: opts.delayMs ?? 5000,
      timeout: {
        milliseconds: (opts.maxAttempts ?? 30) * (opts.delayMs ?? 5000),
      },
    });
    return true;
  } catch {
    return false;
  }
}
