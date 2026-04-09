/**
 * Tests for safe.ts -- async error suppression utility.
 */

import { describe, it, expect, mock, afterEach } from "bun:test";
import { safeAsync } from "../safe.js";

describe("safeAsync", () => {
  it("returns true when function succeeds", async () => {
    const result = await safeAsync("test", async () => {});
    expect(result).toBe(true);
  });

  it("returns false when function throws", async () => {
    const result = await safeAsync("test", async () => {
      throw new Error("boom");
    });
    expect(result).toBe(false);
  });

  it("returns false for non-Error throws", async () => {
    const result = await safeAsync("test", async () => {
      throw "string error";
    });
    expect(result).toBe(false);
  });

  it("does not propagate the error", async () => {
    // Should not throw — the point of safeAsync is error suppression
    let threw = false;
    try {
      await safeAsync("test", async () => { throw new Error("should be caught"); });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it("executes the provided function", async () => {
    let called = false;
    await safeAsync("test", async () => { called = true; });
    expect(called).toBe(true);
  });

  it("handles async rejections", async () => {
    const result = await safeAsync("test", () => Promise.reject(new Error("rejected")));
    expect(result).toBe(false);
  });

  it("does not call console.error (uses structured logging)", async () => {
    const origConsoleError = console.error;
    const consoleMock = mock(() => {});
    console.error = consoleMock;
    try {
      await safeAsync("test", async () => { throw new Error("should use logError"); });
      expect(consoleMock).not.toHaveBeenCalled();
    } finally {
      console.error = origConsoleError;
    }
  });
});
