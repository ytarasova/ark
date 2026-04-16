import { describe, it, expect } from "bun:test";
import { getDateRange } from "../burn.js";

function at(iso: string, fn: () => void) {
  const real = Date;
  // @ts-expect-error  override for test
  globalThis.Date = class extends real {
    constructor(...args: any[]) {
      if (args.length === 0) return new real(iso);
      // @ts-expect-error
      return new real(...args);
    }
    static now() { return new real(iso).getTime(); }
  };
  try { fn(); } finally { globalThis.Date = real; }
}

describe("getDateRange", () => {
  it("today in UTC: start = UTC midnight", () => {
    at("2026-04-16T15:30:00Z", () => {
      const r = getDateRange("today", "UTC");
      expect(r.start).toBe("2026-04-16T00:00:00.000Z");
    });
  });

  it("today in America/New_York at 23:00 EDT: start = EDT midnight of local date", () => {
    at("2026-04-16T03:00:00Z", () => {
      const r = getDateRange("today", "America/New_York");
      expect(r.start).toBe("2026-04-15T04:00:00.000Z");
    });
  });

  it("week covers 7 calendar days (not 8)", () => {
    at("2026-04-16T15:00:00Z", () => {
      const r = getDateRange("week", "UTC");
      expect(r.start).toBe("2026-04-10T00:00:00.000Z");
    });
  });

  it("30days covers 30 calendar days (not 31)", () => {
    at("2026-04-16T15:00:00Z", () => {
      const r = getDateRange("30days", "UTC");
      expect(r.start).toBe("2026-03-18T00:00:00.000Z");
    });
  });

  it("undefined tz falls back to UTC (regression guard)", () => {
    at("2026-04-16T15:30:00Z", () => {
      const r = getDateRange("today", undefined);
      expect(r.start).toBe("2026-04-16T00:00:00.000Z");
    });
  });
});
