/**
 * LLM Router -- retry with exponential backoff + jitter.
 *
 * Used by Provider.complete / Provider.stream to retry transient upstream
 * failures (network errors, 408/429/5xx) before surfacing the error to
 * the circuit breaker. Honors Retry-After headers (seconds or HTTP date).
 *
 * Retry budget defaults to `provider.config.max_retries ?? 2` -- this is
 * the number of *additional* attempts after the initial call, so 2 means
 * up to 3 total requests.
 */

// ── Error classification ─────────────────────────────────────────────────────

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** ECONN* / ENOTFOUND / ETIMEDOUT / abort -- transient network / TCP issues. */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Wraps either a thrown Error (fetch rejection / abort) or a Response with a
 * retryable status. The retry loop converts both into this shape so callers
 * can decide whether to back off.
 */
export interface RetryClassification {
  retryable: boolean;
  /** Server-requested delay in ms (from Retry-After), if present. */
  retryAfterMs?: number;
  /** Human-readable reason used for logs / error messages. */
  reason: string;
}

export function classifyResponse(resp: Response): RetryClassification {
  if (resp.ok) return { retryable: false, reason: "ok" };
  const retryAfterMs = parseRetryAfter(resp.headers.get("retry-after") ?? resp.headers.get("Retry-After"));
  if (RETRYABLE_STATUS.has(resp.status)) {
    return { retryable: true, retryAfterMs, reason: `HTTP ${resp.status}` };
  }
  return { retryable: false, reason: `HTTP ${resp.status}` };
}

export function classifyError(err: unknown): RetryClassification {
  if (!(err instanceof Error)) return { retryable: false, reason: String(err) };
  const anyErr = err as Error & { code?: string; cause?: { code?: string } };
  const code = anyErr.code ?? anyErr.cause?.code;
  if (anyErr.name === "AbortError") return { retryable: true, reason: "AbortError (timeout)" };
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return { retryable: true, reason: `network ${code}` };
  // Bun/undici sometimes surface "fetch failed" without a code -- treat as
  // retryable since it's almost always transient TCP/DNS.
  if (/fetch failed|socket hang up|network/i.test(anyErr.message)) {
    return { retryable: true, reason: anyErr.message };
  }
  return { retryable: false, reason: anyErr.message };
}

/**
 * Parse a Retry-After header. Returns ms or undefined.
 * Format can be seconds (e.g. "5") or an HTTP date.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (!trimmed) return undefined;
  // Numeric seconds
  const secs = Number(trimmed);
  if (!Number.isNaN(secs) && secs >= 0) return Math.round(secs * 1000);
  // HTTP date
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

// ── Retry driver ─────────────────────────────────────────────────────────────

export interface RetryOpts {
  /** Max additional attempts after the initial call. Total attempts = retries + 1. */
  retries: number;
  /** Base delay in ms for exponential backoff. Default 250. */
  baseDelayMs?: number;
  /** Max delay cap in ms. Default 20_000. */
  maxDelayMs?: number;
  /** Sleep injection for tests. Defaults to setTimeout-backed. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after each failure (useful for logs / metrics). */
  onAttempt?: (info: { attempt: number; delayMs: number; reason: string }) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function computeBackoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  // Exponential: base * 2^attempt, capped, with full jitter (0..computed).
  const exp = baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxDelayMs);
  return Math.round(Math.random() * capped);
}

/**
 * Invoke `fn` with retries. `fn` must either:
 *   - return a Response: retry if classifyResponse(resp).retryable is true
 *   - throw an Error: retry if classifyError(err).retryable is true
 *
 * Returns the first successful Response, or throws after exhausting retries.
 * Non-retryable errors / responses are surfaced immediately.
 */
export async function fetchWithRetry(fn: () => Promise<Response>, opts: RetryOpts): Promise<Response> {
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 20_000;
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, opts.retries + 1);

  let lastReason = "no attempts";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let resp: Response | null = null;
    let classification: RetryClassification;

    try {
      resp = await fn();
      classification = classifyResponse(resp);
      if (!classification.retryable) return resp; // success or non-retryable HTTP error
    } catch (err) {
      classification = classifyError(err);
      if (!classification.retryable) throw err;
      lastReason = classification.reason;
    }

    lastReason = classification.reason;

    // If this was the final attempt, surface the failure.
    if (attempt === maxAttempts - 1) {
      if (resp) return resp; // let caller throw with response text
      throw new Error(`Retries exhausted (${maxAttempts} attempts): ${lastReason}`);
    }

    const computedDelay = computeBackoff(attempt, baseDelayMs, maxDelayMs);
    const delayMs =
      classification.retryAfterMs !== undefined ? Math.max(classification.retryAfterMs, 0) : computedDelay;
    opts.onAttempt?.({ attempt: attempt + 1, delayMs, reason: lastReason });

    // Drain the body of a retryable response so the connection can be reused.
    if (resp) {
      try {
        await resp.body?.cancel();
      } catch {
        // ignore
      }
    }

    await sleep(delayMs);
  }

  // Unreachable, but keeps TS happy.
  throw new Error(`Retries exhausted: ${lastReason}`);
}
