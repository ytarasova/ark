import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import type { ComputeProvider } from "../types.js";
import { AppContext } from "../../app.js";
import { setApp, clearApp } from "../../__tests__/test-helpers.js";

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  setApp(app);
  await app.boot();
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

const fakeProvider: ComputeProvider = {
  name: "fake",
  isolationModes: [],
  singleton: false,
  canReboot: false,
  canDelete: false,
  supportsWorktree: false,
  initialStatus: "running",
  needsAuth: false,
  supportsSecretMount: false,
  provision: async () => {},
  destroy: async () => {},
  start: async () => {},
  stop: async () => {},
  launch: async () => "tmux-name",
  attach: async () => {},
  killAgent: async () => {},
  captureOutput: async () => "",
  cleanupSession: async () => {},
  getMetrics: async () => ({
    metrics: {
      cpu: 0,
      memUsedGb: 0,
      memTotalGb: 0,
      memPct: 0,
      diskPct: 0,
      netRxMb: 0,
      netTxMb: 0,
      uptime: "",
      idleTicks: 0,
    },
    sessions: [],
    processes: [],
    docker: [],
  }),
  probePorts: async () => [],
  syncEnvironment: async () => {},
  checkSession: async () => false,
  getAttachCommand: () => [],
  buildChannelConfig: () => ({}),
  buildLaunchEnv: () => ({}),
};

describe("provider registry (via AppContext)", () => {
  it("registers and retrieves a provider", () => {
    app.registerProvider(fakeProvider);
    expect(app.getProvider("fake")).toBe(fakeProvider);
  });

  it("returns null for unknown provider", () => {
    expect(app.getProvider("nope")).toBeNull();
  });

  it("lists registered providers", () => {
    app.registerProvider(fakeProvider);
    app.registerProvider({ ...fakeProvider, name: "other" });
    expect(app.listProviders()).toContain("fake");
    expect(app.listProviders()).toContain("other");
  });

  it("overwrites on re-register", () => {
    app.registerProvider(fakeProvider);
    const updated = { ...fakeProvider };
    app.registerProvider(updated);
    expect(app.getProvider("fake")).toBe(updated);
  });

  it("boot auto-registers local, docker, devcontainer, firecracker providers", () => {
    expect(app.getProvider("local")).not.toBeNull();
    expect(app.getProvider("local")!.name).toBe("local");
    expect(app.getProvider("docker")).not.toBeNull();
    expect(app.getProvider("devcontainer")).not.toBeNull();
    expect(app.getProvider("firecracker")).not.toBeNull();
  });
});
