/**
 * Transient-error retry layer for ArkdClient fetches.
 *
 * Bun's connection pool can hand out a socket that an SSM tunnel has
 * silently torn down; the next fetch surfaces ECONNRESET-shaped errors
 * even though arkd is healthy. We retry twice with backoff (250ms, 1s)
 * before wrapping in ArkdClientTransportError.
 */

import { ArkdClientError, ArkdClientTransportError } from "../common/errors.js";

/**
 * Recognize transient transport-level fetch failures: a stale pooled
 * keep-alive socket closed by the peer (or the SSM port-forward that
 * carries it) surfaces as `TypeError: The socket connection was closed
 * unexpectedly`. Retrying immediately opens a fresh socket and almost
 * always succeeds.
 *
 * We intentionally do NOT retry timeouts (those are caller-shaped) or
 * ArkdClientError (those are real arkd-side rejects with codes).
 */
export function isTransientTransportError(e: unknown): boolean {
  if (e instanceof ArkdClientError) return false;
  const msg = (e as { message?: string })?.message ?? String(e);
  return (
    msg.includes("socket connection was closed") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("EPIPE") ||
    msg.includes("fetch failed")
  );
}

/**
 * Fetch with bounded transient-error retry. Each attempt gets the full
 * timeout budget; we don't shorten it because the original request
 * might have been partway through a long arkd-side exec.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  path: string,
  method: "GET" | "POST",
): Promise<Response> {
  const delays = [250, 1000];
  let lastErr: unknown = null;
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error(`arkd ${path}: timeout after ${timeoutMs}ms`)), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } catch (e) {
      lastErr = e;
      if (attempt < delays.length && isTransientTransportError(e)) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      throw new ArkdClientTransportError(
        `arkd ${method} ${url} failed after ${attempt + 1} attempt(s): ` +
          `${(e as { message?: string })?.message ?? String(e)}`,
        { url, method, path, attempts: attempt + 1, cause: e },
      );
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}
