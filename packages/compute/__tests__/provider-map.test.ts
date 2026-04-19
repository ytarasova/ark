/**
 * Exhaustive test for the legacy provider-name -> (Compute, Runtime) mapping.
 *
 * Every name that today's code registers or persists must map to a real
 * (ComputeKind, RuntimeKind) pair, and the reverse mapping must round-trip.
 */

import { describe, it, expect } from "bun:test";
import {
  providerToPair,
  pairToProvider,
  isKnownProvider,
  knownProviders,
  type ComputeRuntimePair,
} from "../adapters/provider-map.js";

describe("providerToPair", () => {
  // Every provider name that ships today (see app.ts step 4, plus legacy
  // aliases kept for back-compat reads from older DB rows).
  const CASES: Array<[string, ComputeRuntimePair]> = [
    ["local", { compute: "local", runtime: "direct" }],
    ["docker", { compute: "local", runtime: "docker" }],
    ["devcontainer", { compute: "local", runtime: "devcontainer" }],
    ["firecracker", { compute: "local", runtime: "firecracker-in-container" }],
    ["ec2", { compute: "ec2", runtime: "direct" }],
    ["ec2-docker", { compute: "ec2", runtime: "docker" }],
    ["ec2-devcontainer", { compute: "ec2", runtime: "devcontainer" }],
    ["ec2-firecracker", { compute: "ec2", runtime: "firecracker-in-container" }],
    ["remote-arkd", { compute: "ec2", runtime: "direct" }],
    ["remote-worktree", { compute: "ec2", runtime: "direct" }],
    ["remote-docker", { compute: "ec2", runtime: "docker" }],
    ["remote-devcontainer", { compute: "ec2", runtime: "devcontainer" }],
    ["remote-firecracker", { compute: "ec2", runtime: "firecracker-in-container" }],
    ["k8s", { compute: "k8s", runtime: "direct" }],
    ["k8s-kata", { compute: "k8s-kata", runtime: "direct" }],
    ["e2b", { compute: "e2b", runtime: "direct" }],
    ["fly-machines", { compute: "fly-machines", runtime: "direct" }],
  ];

  for (const [name, expected] of CASES) {
    it(`maps '${name}' to ${expected.compute} + ${expected.runtime}`, () => {
      expect(providerToPair(name)).toEqual(expected);
    });
  }

  it("falls back to local + direct for unknown names", () => {
    expect(providerToPair("fake-provider-xyz")).toEqual({ compute: "local", runtime: "direct" });
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
      "e2b",
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
    expect(pairToProvider({ compute: "fly-machines", runtime: "devcontainer" } as any)).toBeNull();
  });
});
