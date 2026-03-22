import { describe, it, expect } from "bun:test";
import { collectLocalMetrics } from "../providers/local/metrics.js";

describe("local metrics", () => {
  it("returns a valid HostSnapshot", async () => {
    const snap = await collectLocalMetrics();
    expect(snap.metrics.cpu).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.cpu).toBeLessThanOrEqual(100);
    expect(snap.metrics.memTotalGb).toBeGreaterThan(0);
    expect(snap.metrics.memUsedGb).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.memPct).toBeGreaterThanOrEqual(0);
    expect(snap.metrics.diskPct).toBeGreaterThan(0);
    expect(snap.metrics.uptime.length).toBeGreaterThan(0);
    expect(Array.isArray(snap.sessions)).toBe(true);
    expect(Array.isArray(snap.processes)).toBe(true);
    expect(Array.isArray(snap.docker)).toBe(true);
  }, 30_000);

  it("session entries have required fields", async () => {
    const snap = await collectLocalMetrics();
    for (const s of snap.sessions) {
      expect(s).toHaveProperty("name");
      expect(s).toHaveProperty("status");
      expect(s).toHaveProperty("mode");
    }
  }, 30_000);
});
