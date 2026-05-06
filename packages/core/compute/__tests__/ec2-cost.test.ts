import { describe, it, expect } from "bun:test";
import { PRICING, EBS_GB_MONTH, hourlyRate, estimateDailyCost, fetchAwsCost } from "../ec2/cost.js";

describe("EC2 cost tracking", () => {
  it("hourlyRate returns a positive number for m6i.2xlarge", () => {
    expect(hourlyRate("m6i.2xlarge")).toBeGreaterThan(0);
  });

  it("hourlyRate returns a positive number for m6g.xlarge (ARM)", () => {
    expect(hourlyRate("m6g.xlarge")).toBeGreaterThan(0);
  });

  it("hourlyRate returns 0 for unknown instance type", () => {
    expect(hourlyRate("z9.unknown")).toBe(0);
  });

  it("estimateDailyCost for m6i.2xlarge with 256 GB disk is between 9 and 12", () => {
    const cost = estimateDailyCost("m6i.2xlarge", 256);
    expect(cost).toBeGreaterThan(9);
    expect(cost).toBeLessThan(12);
  });

  it("estimateDailyCost with 0 disk still returns compute cost", () => {
    const cost = estimateDailyCost("m6i.2xlarge", 0);
    expect(cost).toBeGreaterThan(0);
    // Should be purely compute: 0.384 * 24 = 9.216
    expect(cost).toBe(hourlyRate("m6i.2xlarge") * 24);
  });

  it("PRICING has entries for all 14 instance types (7 sizes x 2 architectures)", () => {
    expect(Object.keys(PRICING)).toHaveLength(14);
    // Verify both families present
    const m6iKeys = Object.keys(PRICING).filter((k) => k.startsWith("m6i."));
    const m6gKeys = Object.keys(PRICING).filter((k) => k.startsWith("m6g."));
    expect(m6iKeys).toHaveLength(7);
    expect(m6gKeys).toHaveLength(7);
  });

  it("fetchAwsCost is a function", () => {
    expect(typeof fetchAwsCost).toBe("function");
  });
});
