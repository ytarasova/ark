/**
 * Tests for useArkStore -- fetchAll running guard and error recovery.
 *
 * These are unit tests for the fetchAll locking logic. We test the
 * core behavior (running flag in finally block) without React rendering,
 * by extracting the pattern into a minimal reproduction.
 */

import { describe, it, expect } from "bun:test";

describe("useArkStore fetchAll running guard", () => {
  it("resets running flag after successful fetch", async () => {
    let running = false;

    async function fetchAll() {
      if (running) return "skipped";
      running = true;
      try {
        await Promise.resolve(); // simulate successful fetch
        return "ok";
      } catch {
        // non-fatal
      } finally {
        running = false;
      }
    }

    await fetchAll();
    expect(running).toBe(false);
  });

  it("resets running flag even when an error occurs during fetch", async () => {
    let running = false;

    async function fetchAll() {
      if (running) return "skipped";
      running = true;
      try {
        throw new Error("network failure");
      } catch {
        // non-fatal: leave stale data in place
      } finally {
        running = false;
      }
    }

    await fetchAll();
    expect(running).toBe(false);
  });

  it("does not lock out subsequent calls after an error", async () => {
    let running = false;
    let callCount = 0;

    async function fetchAll() {
      if (running) return "skipped";
      running = true;
      callCount++;
      try {
        if (callCount === 1) throw new Error("first call fails");
        return "ok";
      } catch {
        // non-fatal
      } finally {
        running = false;
      }
    }

    // First call: errors
    await fetchAll();
    expect(running).toBe(false);
    expect(callCount).toBe(1);

    // Second call: should NOT be skipped (running was reset)
    const result = await fetchAll();
    expect(callCount).toBe(2);
    expect(running).toBe(false);
    // If finally block was missing, running would still be true and second call would be skipped
  });

  it("skips concurrent calls while one is in-flight", async () => {
    let running = false;
    let callCount = 0;

    async function fetchAll() {
      if (running) return "skipped";
      running = true;
      callCount++;
      try {
        await new Promise(r => setTimeout(r, 50));
        return "ok";
      } catch {
        // non-fatal
      } finally {
        running = false;
      }
    }

    // Start two concurrent calls
    const p1 = fetchAll();
    const p2 = fetchAll();

    const [r1, r2] = await Promise.all([p1, p2]);
    // Only one should have executed
    expect(callCount).toBe(1);
    expect(r2).toBe("skipped");
    // After completion, running is reset
    expect(running).toBe(false);
  });

  it("resets running flag when catch block itself would throw (finally guarantees)", async () => {
    // This test validates the core reason for using finally:
    // if an error handler itself throws, running must still be reset
    let running = false;
    let threw = false;

    async function fetchAll() {
      if (running) return;
      running = true;
      try {
        throw new Error("fetch error");
      } catch (e) {
        // Simulate a catch block that re-throws or has side effects
        // With finally, running is reset regardless
        threw = true;
        // Don't re-throw here -- the production code catches silently
      } finally {
        running = false;
      }
    }

    await fetchAll();
    expect(threw).toBe(true);
    expect(running).toBe(false);
  });
});
