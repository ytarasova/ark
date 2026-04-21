/**
 * Tests for the compute utility functions: retry, poll, sleep.
 *
 * These wrap p-retry and p-wait-for with a simpler interface
 * used throughout the compute layer for resilient async operations.
 */

import { describe, it, expect } from "bun:test";
import { retry, poll, sleep } from "../util.js";

describe("retry (p-retry wrapper)", async () => {
  it("returns result on first success", async () => {
    const result = await retry(async () => 42);
    expect(result).toBe(42);
  });

  it("retries on failure and succeeds", async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("not yet");
        return "done";
      },
      { maxAttempts: 5, delayMs: 100 },
    );
    expect(result).toBe("done");
    expect(attempts).toBe(3);
  });

  it("returns null after exhausting attempts", async () => {
    const result = await retry(
      async () => {
        throw new Error("always fails");
      },
      { maxAttempts: 3, delayMs: 100 },
    );
    expect(result).toBeNull();
  });

  it("calls onRetry on each failed attempt", async () => {
    const retries: number[] = [];
    await retry(
      async () => {
        throw new Error("fail");
      },
      {
        maxAttempts: 3,
        delayMs: 100,
        onRetry: (n) => retries.push(n),
      },
    );
    expect(retries.length).toBe(3);
  });

  it("returns result type correctly", async () => {
    const result = await retry(async () => ({ key: "value" }));
    expect(result).toEqual({ key: "value" });
  });

  it("calls onAttempt before each attempt", async () => {
    const attempts: number[] = [];
    let count = 0;
    await retry(
      async () => {
        count++;
        if (count < 2) throw new Error("fail");
        return "ok";
      },
      {
        maxAttempts: 3,
        delayMs: 100,
        onAttempt: (n) => attempts.push(n),
      },
    );
    expect(attempts.length).toBe(2);
  });
});

describe("poll (p-wait-for wrapper)", async () => {
  it("returns true when condition is met immediately", async () => {
    const result = await poll(() => true, { maxAttempts: 10, delayMs: 100 });
    expect(result).toBe(true);
  });

  it("returns true when condition is met after a few checks", async () => {
    let count = 0;
    const result = await poll(
      () => {
        count++;
        return count >= 3;
      },
      { maxAttempts: 10, delayMs: 100 },
    );
    expect(result).toBe(true);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("returns false on timeout", async () => {
    const result = await poll(() => false, { maxAttempts: 3, delayMs: 100 });
    expect(result).toBe(false);
  });

  it("handles async check function", async () => {
    let count = 0;
    const result = await poll(
      async () => {
        count++;
        return count >= 2;
      },
      { maxAttempts: 5, delayMs: 100 },
    );
    expect(result).toBe(true);
  });
});

describe("sleep", async () => {
  it("resolves after delay", async () => {
    const start = Date.now();
    await sleep(100);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it("resolves with no value", async () => {
    const result = await sleep(10);
    expect(result).toBeUndefined();
  });
});
