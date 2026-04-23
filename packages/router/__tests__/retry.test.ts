/**
 * Retry helper tests -- classifier, backoff, Retry-After honoring,
 * exhaustion, and terminal errors.
 */

import { describe, test, expect } from "bun:test";
import { classifyResponse, classifyError, parseRetryAfter, fetchWithRetry } from "../retry.js";

function okResp(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function errResp(status: number, headers: Record<string, string> = {}): Response {
  return new Response(`{"error":"${status}"}`, { status, headers });
}

function makeRecordingSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: async (ms: number) => {
      calls.push(ms);
    },
  };
}

describe("retry classifier", () => {
  test("classifies 408/429/500/502/503/504 as retryable", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifyResponse(errResp(status)).retryable).toBe(true);
    }
  });

  test("classifies 400/401/403/404/422 as terminal", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyResponse(errResp(status)).retryable).toBe(false);
    }
  });

  test("200 is not retryable (ok branch)", () => {
    expect(classifyResponse(okResp()).retryable).toBe(false);
  });

  test("parses numeric Retry-After", () => {
    const resp = errResp(429, { "Retry-After": "5" });
    const cls = classifyResponse(resp);
    expect(cls.retryable).toBe(true);
    expect(cls.retryAfterMs).toBe(5000);
  });

  test("parses HTTP date Retry-After", () => {
    const future = new Date(Date.now() + 2500).toUTCString();
    const resp = errResp(503, { "Retry-After": future });
    const cls = classifyResponse(resp);
    expect(cls.retryable).toBe(true);
    // Within a reasonable window
    expect(cls.retryAfterMs).toBeGreaterThan(0);
    expect(cls.retryAfterMs!).toBeLessThanOrEqual(3000);
  });

  test("parseRetryAfter ignores garbage", () => {
    expect(parseRetryAfter("not-a-thing")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
  });

  test("AbortError is retryable", () => {
    const err = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(classifyError(err).retryable).toBe(true);
  });

  test("ECONN* codes are retryable", () => {
    const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(classifyError(err).retryable).toBe(true);
  });

  test("random programmer error is terminal", () => {
    expect(classifyError(new Error("TypeError: foo")).retryable).toBe(false);
  });

  test("fetch failed message is retryable (undici network)", () => {
    expect(classifyError(new Error("fetch failed")).retryable).toBe(true);
  });
});

describe("fetchWithRetry", () => {
  test("503 then 200 succeeds after one retry", async () => {
    const { sleep, calls } = makeRecordingSleep();
    let attempt = 0;
    const resp = await fetchWithRetry(
      async () => {
        attempt++;
        return attempt === 1 ? errResp(503) : okResp();
      },
      { retries: 2, sleep, baseDelayMs: 10, maxDelayMs: 20 },
    );
    expect(attempt).toBe(2);
    expect(resp.status).toBe(200);
    expect(calls.length).toBe(1); // one sleep between the two attempts
  });

  test("429 with Retry-After: 5 delays >= 5s (mock clock)", async () => {
    const { sleep, calls } = makeRecordingSleep();
    let attempt = 0;
    await fetchWithRetry(
      async () => {
        attempt++;
        return attempt === 1 ? errResp(429, { "Retry-After": "5" }) : okResp();
      },
      { retries: 2, sleep, baseDelayMs: 10, maxDelayMs: 20 },
    );
    expect(attempt).toBe(2);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(5000);
  });

  test("4 consecutive failures exhaust retries (retries=3 => 4 attempts)", async () => {
    const { sleep } = makeRecordingSleep();
    let attempt = 0;
    const resp = await fetchWithRetry(
      async () => {
        attempt++;
        return errResp(503);
      },
      { retries: 3, sleep, baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(attempt).toBe(4);
    // We surface the final Response; caller is expected to throw using its body
    expect(resp.status).toBe(503);
  });

  test("non-retryable 400 fails immediately (no sleeps)", async () => {
    const { sleep, calls } = makeRecordingSleep();
    let attempt = 0;
    const resp = await fetchWithRetry(
      async () => {
        attempt++;
        return errResp(400);
      },
      { retries: 3, sleep, baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(attempt).toBe(1);
    expect(resp.status).toBe(400);
    expect(calls.length).toBe(0);
  });

  test("terminal network error rejects immediately", async () => {
    const { sleep, calls } = makeRecordingSleep();
    let attempt = 0;
    await expect(
      fetchWithRetry(
        async () => {
          attempt++;
          throw new Error("oops programmer");
        },
        { retries: 3, sleep, baseDelayMs: 1, maxDelayMs: 2 },
      ),
    ).rejects.toThrow("oops programmer");
    expect(attempt).toBe(1);
    expect(calls.length).toBe(0);
  });

  test("retryable network error then success", async () => {
    const { sleep } = makeRecordingSleep();
    let attempt = 0;
    const resp = await fetchWithRetry(
      async () => {
        attempt++;
        if (attempt === 1) {
          const err = Object.assign(new Error("reset"), { code: "ECONNRESET" });
          throw err;
        }
        return okResp();
      },
      { retries: 2, sleep, baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(attempt).toBe(2);
    expect(resp.status).toBe(200);
  });

  test("backoff delays grow exponentially (upper-bounded)", async () => {
    const { sleep, calls } = makeRecordingSleep();
    let attempt = 0;
    await fetchWithRetry(
      async () => {
        attempt++;
        return errResp(503);
      },
      { retries: 3, sleep, baseDelayMs: 100, maxDelayMs: 10_000 },
    );
    // 3 sleeps between 4 attempts; each <= 2^attempt * base (jittered full jitter so <= cap)
    expect(calls.length).toBe(3);
    expect(calls[0]).toBeLessThanOrEqual(100);
    expect(calls[1]).toBeLessThanOrEqual(200);
    expect(calls[2]).toBeLessThanOrEqual(400);
  });

  test("retries=0 means exactly one attempt", async () => {
    const { sleep, calls } = makeRecordingSleep();
    let attempt = 0;
    const resp = await fetchWithRetry(
      async () => {
        attempt++;
        return errResp(503);
      },
      { retries: 0, sleep, baseDelayMs: 1, maxDelayMs: 2 },
    );
    expect(attempt).toBe(1);
    expect(calls.length).toBe(0);
    expect(resp.status).toBe(503);
  });
});
