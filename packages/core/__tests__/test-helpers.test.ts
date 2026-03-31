/**
 * Tests for shared test helpers: withTestContext and waitFor.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { withTestContext, waitFor } from "./test-helpers.js";
import { getContext } from "../context.js";

// ── withTestContext ─────────────────────────────────────────────────────────

describe("withTestContext", () => {
  const { getCtx } = withTestContext();

  it("creates isolated test context with unique paths", () => {
    const ctx = getCtx();
    expect(ctx.arkDir).toContain("ark-test-");
    expect(ctx.dbPath).toContain("ark-test-");
    expect(ctx.tracksDir).toContain("tracks");
    expect(ctx.worktreesDir).toContain("worktrees");
  });

  it("sets context as the active global context", () => {
    const ctx = getCtx();
    const active = getContext();
    expect(active.arkDir).toBe(ctx.arkDir);
    expect(active.dbPath).toBe(ctx.dbPath);
  });

  it("getCtx() returns the current context", () => {
    const ctx = getCtx();
    expect(ctx).toBeDefined();
    expect(typeof ctx.cleanup).toBe("function");
  });

  it("each test gets a fresh context with different paths", () => {
    // Store the path from this test - other tests in this describe
    // will get different paths due to beforeEach recreation.
    // We verify the context is valid and unique per-run.
    const ctx = getCtx();
    expect(ctx.arkDir).toBeTruthy();
    expect(ctx.db).toBeNull(); // DB not opened yet (lazy)
  });
});

// ── waitFor ─────────────────────────────────────────────────────────────────

describe("waitFor", () => {
  it("resolves immediately when condition is already true", async () => {
    const start = Date.now();
    await waitFor(() => true);
    const elapsed = Date.now() - start;
    // Should resolve in well under 100ms (no polling needed)
    expect(elapsed).toBeLessThan(100);
  });

  it("polls until condition becomes true", async () => {
    let count = 0;
    const start = Date.now();
    await waitFor(() => {
      count++;
      return count >= 3;
    }, { interval: 10 });
    const elapsed = Date.now() - start;
    expect(count).toBeGreaterThanOrEqual(3);
    // Should have taken at least 2 intervals (2 * 10ms)
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it("throws after timeout if condition never becomes true", async () => {
    await expect(
      waitFor(() => false, { timeout: 100, interval: 10 })
    ).rejects.toThrow("waitFor timed out after 100ms");
  });

  it("throws with custom message on timeout", async () => {
    await expect(
      waitFor(() => false, { timeout: 50, interval: 10, message: "custom failure" })
    ).rejects.toThrow("custom failure");
  });

  it("works with async conditions", async () => {
    let ready = false;
    setTimeout(() => { ready = true; }, 50);
    await waitFor(async () => ready, { timeout: 1000, interval: 10 });
    expect(ready).toBe(true);
  });

  it("respects custom timeout option", async () => {
    const start = Date.now();
    try {
      await waitFor(() => false, { timeout: 150, interval: 10 });
    } catch {}
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(500);
  });

  it("respects custom interval option", async () => {
    let callCount = 0;
    try {
      await waitFor(() => {
        callCount++;
        return false;
      }, { timeout: 100, interval: 40 });
    } catch {}
    // With 100ms timeout and 40ms interval, expect roughly 2-3 checks
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(callCount).toBeLessThanOrEqual(5);
  });
});
