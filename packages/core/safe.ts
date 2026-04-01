/**
 * Safe async execution helper — eliminates try/catch nesting for
 * fire-and-forget error handling.
 */

/** Run an async function, log errors instead of throwing. Returns true on success. */
export async function safeAsync(label: string, fn: () => Promise<void>): Promise<boolean> {
  try { await fn(); return true; }
  catch (e: any) { console.error(`${label}:`, e?.message ?? e); return false; }
}
