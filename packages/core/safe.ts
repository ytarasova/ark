/**
 * Safe async execution helper -- eliminates try/catch nesting for
 * fire-and-forget error handling.
 */

import { logError } from "./structured-log.js";

/** Run an async function, log errors instead of throwing. Returns true on success. */
export async function safeAsync(label: string, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e: any) {
    const message = e instanceof Error ? e.message : String(e);
    const data: Record<string, unknown> = {};
    if (e instanceof Error && e.stack) {
      data.stack = e.stack;
    }
    logError("general", `${label}: ${message}`, Object.keys(data).length > 0 ? data : undefined);
    return false;
  }
}
