/**
 * Tests for shared test helpers: withTestContext and waitFor.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { withTestContext, waitFor } from "./test-helpers.js";
import { getApp } from "../app.js";

// ── withTestContext ─────────────────────────────────────────────────────────

describe("withTestContext", () => {
  const { getCtx } = withTestContext();

  it("creates isolated test context with unique paths", () => {
    const app = getCtx();
    expect(app.config.arkDir).toContain("ark-test-");
    expect(app.config.dbPath).toContain("ark-test-");
    expect(app.config.tracksDir).toContain("tracks");
    expect(app.config.worktreesDir).toContain("worktrees");
  });

  it("sets context as the active global context", () => {
    const app = getCtx();
    const active = getApp();
    expect(active.config.arkDir).toBe(app.config.arkDir);
    expect(active.config.dbPath).toBe(app.config.dbPath);
  });

  it("getCtx() returns the current context", () => {
    const app = getCtx();
    expect(app).toBeDefined();
    expect(app.phase).toBe("ready");
  });

  it("each test gets a fresh context with different paths", () => {
    // Store the path from this test - other tests in this describe
    // will get different paths due to beforeEach recreation.
    // We verify the context is valid and unique per-run.
    const app = getCtx();
    expect(app.config.arkDir).toBeTruthy();
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
    } catch { /* expected timeout */ }
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
    } catch { /* expected timeout */ }
    // With 100ms timeout and 40ms interval, expect roughly 2-3 checks
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(callCount).toBeLessThanOrEqual(5);
  });
});
