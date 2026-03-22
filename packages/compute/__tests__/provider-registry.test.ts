import { describe, it, expect, beforeEach } from "bun:test";
import { registerProvider, getProvider, listProviders, clearProviders } from "../index.js";
import type { ComputeProvider } from "../types.js";

const fakeProvider: ComputeProvider = {
  name: "fake",
  provision: async () => {},
  destroy: async () => {},
  start: async () => {},
  stop: async () => {},
  launch: async () => "tmux-name",
  attach: async () => {},
  getMetrics: async () => ({
    metrics: { cpu: 0, memUsedGb: 0, memTotalGb: 0, memPct: 0, diskPct: 0, netRxMb: 0, netTxMb: 0, uptime: "", idleTicks: 0 },
    sessions: [], processes: [], docker: [],
  }),
  probePorts: async () => [],
  syncEnvironment: async () => {},
};

beforeEach(() => clearProviders());

describe("provider registry", () => {
  it("registers and retrieves a provider", () => {
    registerProvider(fakeProvider);
    expect(getProvider("fake")).toBe(fakeProvider);
  });

  it("returns null for unknown provider", () => {
    expect(getProvider("nope")).toBeNull();
  });

  it("lists registered providers", () => {
    registerProvider(fakeProvider);
    registerProvider({ ...fakeProvider, name: "other" });
    expect(listProviders()).toEqual(["fake", "other"]);
  });

  it("overwrites on re-register", () => {
    registerProvider(fakeProvider);
    const updated = { ...fakeProvider };
    registerProvider(updated);
    expect(getProvider("fake")).toBe(updated);
  });
});
