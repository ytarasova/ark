/**
 * Unit test for parseDockerStats -- the single-call docker-stats collapse
 * replaces two `docker stats --no-stream` invocations with one.
 */

import { describe, test, expect } from "bun:test";
import { parseDockerStats } from "../providers/docker/index.js";

describe("parseDockerStats", () => {
  test("parses a single row", () => {
    const raw = "ark-demo\t1.23%\t123.4MiB / 7.776GiB\t1.55%";
    const rows = parseDockerStats(raw);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.name).toBe("ark-demo");
    expect(row.cpu).toBeCloseTo(1.23);
    expect(row.memPct).toBeCloseTo(1.55);
    expect(row.memUsedGb).toBeGreaterThan(0.1);
    expect(row.memUsedGb).toBeLessThan(0.2);
    expect(row.memTotalGb).toBeCloseTo(7.78, 1);
    expect(row.cpuRaw).toBe("1.23%");
    expect(row.memRaw).toBe("123.4MiB / 7.776GiB");
  });

  test("parses multiple rows", () => {
    const raw = ["ark-a\t10.5%\t512MiB / 2GiB\t25.0%", "ark-b\t0.0%\t1.5GiB / 8GiB\t18.75%"].join("\n");
    const rows = parseDockerStats(raw);
    expect(rows.length).toBe(2);
    expect(rows[0].name).toBe("ark-a");
    expect(rows[0].cpu).toBeCloseTo(10.5);
    expect(rows[1].name).toBe("ark-b");
    expect(rows[1].memUsedGb).toBeCloseTo(1.5);
    expect(rows[1].memTotalGb).toBe(8);
  });

  test("returns [] on empty string", () => {
    expect(parseDockerStats("")).toEqual([]);
  });

  test("skips malformed lines", () => {
    const raw = ["ark-ok\t5%\t100MiB / 1GiB\t10%", "not-enough-fields", "\t\t\t"].join("\n");
    const rows = parseDockerStats(raw);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].name).toBe("ark-ok");
  });

  test("tolerates missing memory regex match", () => {
    const raw = "ark-weird\t2%\tgarbage-memusage\t3%";
    const rows = parseDockerStats(raw);
    expect(rows.length).toBe(1);
    expect(rows[0].memUsedGb).toBe(0);
    expect(rows[0].memTotalGb).toBe(0);
  });

  test("KiB/MiB/GiB units all convert to GiB", () => {
    const raw = "ark-k\t1%\t1024KiB / 2048MiB\t5%";
    const rows = parseDockerStats(raw);
    expect(rows[0].memUsedGb).toBeCloseTo(0.001, 2);
    expect(rows[0].memTotalGb).toBe(2);
  });
});
