/**
 * Exhaustive test for the legacy provider-name -> (Compute, Isolation) mapping.
 *
 * Every name that today's code registers or persists must map to a real
 * (ComputeKind, IsolationKind) pair, and the reverse mapping must round-trip.
 */
import { describe, it, expect } from "bun:test";
import {
  providerToPair,
  pairToProvider,
  isKnownProvider,
  knownProviders,
  type ComputeIsolationPair,
} from "../adapters/provider-map.js";
describe("providerToPair", () => {
  // Every provider name that ships today (see app.ts step 4, plus legacy
  // aliases kept for back-compat reads from older DB rows).
  const CASES: Array<[string, ComputeIsolationPair]> = [
    ["local", { compute: "local", isolation: "direct" }],
    ["docker", { compute: "local", isolation: "docker" }],
    ["devcontainer", { compute: "local", isolation: "devcontainer" }],
    ["firecracker", { compute: "local", isolation: "firecracker-in-container" }],
    ["ec2", { compute: "ec2", isolation: "direct" }],
    ["ec2-docker", { compute: "ec2", isolation: "docker" }],
    ["ec2-devcontainer", { compute: "ec2", isolation: "devcontainer" }],
    ["ec2-firecracker", { compute: "ec2", isolation: "firecracker-in-container" }],
    ["remote-arkd", { compute: "ec2", isolation: "direct" }],
    ["remote-worktree", { compute: "ec2", isolation: "direct" }],
    ["remote-docker", { compute: "ec2", isolation: "docker" }],
    ["remote-devcontainer", { compute: "ec2", isolation: "devcontainer" }],
    ["remote-firecracker", { compute: "ec2", isolation: "firecracker-in-container" }],
    ["k8s", { compute: "k8s", isolation: "direct" }],
    ["k8s-kata", { compute: "k8s-kata", isolation: "direct" }],
  ];
  for (const [name, expected] of CASES) {
    it(`maps '${name}' to ${expected.compute} + ${expected.isolation}`, () => {
      expect(providerToPair(name)).toEqual(expected);
    });
  }
  it("falls back to local + direct for unknown names", () => {
    expect(providerToPair("fake-provider-xyz")).toEqual({ compute: "local", isolation: "direct" });
  });
});
describe("isKnownProvider", () => {
  it("returns true for registered names", () => {
    expect(isKnownProvider("local")).toBe(true);
    expect(isKnownProvider("ec2-docker")).toBe(true);
    expect(isKnownProvider("k8s-kata")).toBe(true);
  });
  it("returns false for unknown names", () => {
    expect(isKnownProvider("totally-made-up")).toBe(false);
  });
});
describe("knownProviders", () => {
  it("lists at least every provider registered today", () => {
    const names = knownProviders();
    // The names app.ts registers at boot:
    for (const expected of [
      "local",
      "docker",
      "devcontainer",
      "firecracker",
      "ec2",
      "ec2-docker",
      "ec2-devcontainer",
      "ec2-firecracker",
      "k8s",
      "k8s-kata",
    ]) {
      expect(names).toContain(expected);
    }
  });
});
describe("pairToProvider", () => {
  it("round-trips every mapped pair", () => {
    for (const name of knownProviders()) {
      const pair = providerToPair(name);
      const back = pairToProvider(pair);
      // The reverse lookup returns the FIRST match; providers that share a
      // pair (e.g. "ec2" and "remote-arkd" both -> ec2+direct) may not
      // round-trip to the original name, but they must round-trip to SOME
      // name that maps to the same pair.
      expect(back).not.toBeNull();
      expect(providerToPair(back!)).toEqual(pair);
    }
  });
  it("returns null for impossible pairs", () => {
    expect(pairToProvider({ compute: "k8s", isolation: "devcontainer" } as any)).toBeNull();
  });
});
