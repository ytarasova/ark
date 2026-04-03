/**
 * Tests for web utility functions: relTime, fmtCost.
 */

import { describe, it, expect } from "bun:test";
import { relTime, fmtCost } from "../src/util.js";

describe("relTime", () => {
  it("returns empty string for null", () => {
    expect(relTime(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(relTime(undefined)).toBe("");
  });

  it("returns seconds ago for recent timestamps", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    const result = relTime(recent);
    expect(result).toMatch(/^\d+s ago$/);
  });

  it("returns minutes ago for timestamps within an hour", () => {
    const minutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const result = relTime(minutesAgo);
    expect(result).toMatch(/^\d+m ago$/);
  });

  it("returns hours ago for timestamps within a day", () => {
    const hoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const result = relTime(hoursAgo);
    expect(result).toMatch(/^\d+h ago$/);
  });

  it("returns days ago for old timestamps", () => {
    const daysAgo = new Date(Date.now() - 5 * 86400_000).toISOString();
    const result = relTime(daysAgo);
    expect(result).toMatch(/^\d+d ago$/);
  });
});

describe("fmtCost", () => {
  it("formats zero as $0.00", () => {
    expect(fmtCost(0)).toBe("$0.00");
  });

  it("formats small amounts as <$0.01", () => {
    expect(fmtCost(0.005)).toBe("<$0.01");
    expect(fmtCost(0.001)).toBe("<$0.01");
  });

  it("formats normal amounts with two decimal places", () => {
    expect(fmtCost(1.5)).toBe("$1.50");
    expect(fmtCost(42.123)).toBe("$42.12");
  });

  it("formats exact cents", () => {
    expect(fmtCost(0.01)).toBe("$0.01");
    expect(fmtCost(0.10)).toBe("$0.10");
  });
});
