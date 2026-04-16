import { describe, it, expect } from "bun:test";
import { zoneMidnight, zoneOffsetMinutes, zoneSqliteModifier } from "../burn.js";

describe("zoneMidnight", () => {
  it("returns UTC midnight for UTC", () => {
    const d = new Date("2026-04-16T03:00:00Z");
    expect(zoneMidnight("UTC", d).toISOString()).toBe("2026-04-16T00:00:00.000Z");
  });
  it("returns America/New_York midnight for EDT input", () => {
    const d = new Date("2026-04-16T03:00:00Z");
    expect(zoneMidnight("America/New_York", d).toISOString()).toBe("2026-04-15T04:00:00.000Z");
  });
});

describe("zoneOffsetMinutes", () => {
  it("UTC -> 0", () => {
    expect(zoneOffsetMinutes("UTC", new Date("2026-04-16T12:00:00Z"))).toBe(0);
  });
  it("America/New_York in April (EDT) -> -240", () => {
    expect(zoneOffsetMinutes("America/New_York", new Date("2026-04-16T12:00:00Z"))).toBe(-240);
  });
});

describe("zoneSqliteModifier", () => {
  it("UTC -> '+0 hours'", () => {
    expect(zoneSqliteModifier("UTC", new Date("2026-04-16T12:00:00Z"))).toBe("+0 hours");
  });
  it("EDT -> '-4 hours'", () => {
    expect(zoneSqliteModifier("America/New_York", new Date("2026-04-16T12:00:00Z"))).toBe("-4 hours");
  });
});
