import { describe, it, expect } from "bun:test";
import { collectLocalMetrics } from "../providers/local/metrics.js";

describe("local metrics", () => {
  it("returns a valid ComputeSnapshot", async () => {
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

  it("metrics value ranges", async () => {
    const snap = await collectLocalMetrics();
    const m = snap.metrics;

    expect(m.memPct).toBeGreaterThanOrEqual(0);
    expect(m.memPct).toBeLessThanOrEqual(100);

    expect(m.diskPct).toBeGreaterThanOrEqual(0);
    expect(m.diskPct).toBeLessThanOrEqual(100);

    expect(m.memUsedGb).toBeLessThanOrEqual(m.memTotalGb);

    expect(m.idleTicks).toBe(0);

    expect(m.netRxMb).toBe(0);
    expect(m.netTxMb).toBe(0);
  }, 30_000);

  it("process entries have required fields", async () => {
    const snap = await collectLocalMetrics();
    for (const p of snap.processes) {
      expect(typeof p.pid).toBe("string");
      expect(p.pid.length).toBeGreaterThan(0);

      expect(typeof p.cpu).toBe("string");
      expect(p.cpu.length).toBeGreaterThan(0);

      expect(typeof p.mem).toBe("string");
      expect(p.mem.length).toBeGreaterThan(0);

      expect(typeof p.command).toBe("string");
      expect(p.command.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it("docker entries shape", async () => {
    const snap = await collectLocalMetrics();
    for (const d of snap.docker) {
      expect(d).toHaveProperty("name");
      expect(d).toHaveProperty("cpu");
      expect(d).toHaveProperty("memory");
      expect(d).toHaveProperty("image");
      expect(d).toHaveProperty("project");
    }
  }, 30_000);

  it("snapshot structure", async () => {
    const snap = await collectLocalMetrics();
    const keys = Object.keys(snap).sort();
    expect(keys).toEqual(["docker", "metrics", "processes", "sessions"]);
  }, 30_000);

  it("metrics keys", async () => {
    const snap = await collectLocalMetrics();
    const keys = Object.keys(snap.metrics).sort();
    expect(keys).toEqual([
      "cpu",
      "diskPct",
      "idleTicks",
      "memPct",
      "memTotalGb",
      "memUsedGb",
      "netRxMb",
      "netTxMb",
      "uptime",
    ]);
  }, 30_000);
});
