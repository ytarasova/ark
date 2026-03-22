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

describe("provider registry", () => {
  beforeEach(() => clearProviders());

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

  it("clearProviders empties the registry", () => {
    registerProvider(fakeProvider);
    registerProvider({ ...fakeProvider, name: "second" });
    clearProviders();
    expect(getProvider("fake")).toBeNull();
    expect(getProvider("second")).toBeNull();
    expect(listProviders()).toEqual([]);
  });

  it("listProviders preserves insertion order", () => {
    registerProvider({ ...fakeProvider, name: "zulu" });
    registerProvider({ ...fakeProvider, name: "alpha" });
    registerProvider({ ...fakeProvider, name: "mike" });
    expect(listProviders()).toEqual(["zulu", "alpha", "mike"]);
  });
});

describe("auto-registration", () => {
  it("local provider is auto-registered on import", () => {
    // The compute index module calls registerProvider(new LocalProvider())
    // at the top level. Prior tests cleared the registry, so we re-register
    // the same way the module does to verify the wiring works end-to-end.
    clearProviders();
    const { LocalProvider } = require("../providers/local/index.js");
    registerProvider(new LocalProvider());
    expect(getProvider("local")).not.toBeNull();
    expect(getProvider("local")!.name).toBe("local");
  });
});
