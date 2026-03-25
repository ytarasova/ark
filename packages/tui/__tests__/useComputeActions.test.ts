/**
 * Tests for useComputeActions — verifies every action wraps in async.run()
 * with correct labels, calls addLog, and delegates to the provider registry.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  createTestContext, setContext, resetContext,
  createCompute, getCompute, deleteCompute,
  AppContext, setApp, clearApp,
} from "../../core/index.js";
import type { TestContext } from "../../core/store.js";
import type { Compute } from "../../core/store.js";
import { registerProvider, clearProviders } from "../../compute/index.js";
import { useComputeActions } from "../hooks/useComputeActions.js";
import type { AsyncState } from "../hooks/useAsync.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockAsyncState() {
  const state: AsyncState & { ran: { label: string; fn: Function }[] } = {
    loading: false,
    label: null,
    error: null,
    ran: [],
    run(label: string, fn: () => void | Promise<void>) {
      state.ran.push({ label, fn });
      try { fn(); } catch {} // Execute sync side-effects for testing
    },
    clearError() {},
  };
  return state;
}

function mockProvider(name = "mock") {
  return {
    name,
    provision: async () => {},
    destroy: async () => {},
    start: async () => {},
    stop: async () => {},
    launch: async () => "",
    attach: async () => {},
    getMetrics: async () => ({
      cpu: 0, memUsedGb: 0, memTotalGb: 0, memPct: 0,
      diskPct: 0, netRxMb: 0, netTxMb: 0, uptime: "0s", idleTicks: 0,
    }),
    probePorts: async () => [],
    syncEnvironment: async () => {},
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

let ctx: TestContext;
let app: AppContext;

beforeEach(async () => {
  if (ctx) ctx.cleanup();
  ctx = createTestContext();
  setContext(ctx);
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
  clearProviders();
});

afterAll(async () => {
  if (app) await app.shutdown();
  clearApp();
  if (ctx) ctx.cleanup();
  resetContext();
  clearProviders();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useComputeActions", () => {
  it("returns all 5 action functions", () => {
    const async = mockAsyncState();
    const actions = useComputeActions(async, () => {});

    expect(typeof actions.provision).toBe("function");
    expect(typeof actions.stop).toBe("function");
    expect(typeof actions.start).toBe("function");
    expect(typeof actions.delete).toBe("function");
    expect(typeof actions.clean).toBe("function");
  });

  it("delete removes compute from store", () => {
    const compute = createCompute({ name: "del-target", provider: "local" });
    expect(getCompute("del-target")).not.toBeNull();

    const async = mockAsyncState();
    const actions = useComputeActions(async, () => {});
    actions.delete("del-target");

    expect(getCompute("del-target")).toBeNull();
    expect(async.ran.length).toBe(1);
    expect(async.ran[0].label).toBe("Deleting del-target");
  });

  it("provision calls run with correct label", () => {
    registerProvider(mockProvider("mock"));
    const compute = createCompute({ name: "prov-box", provider: "mock" });

    const async = mockAsyncState();
    const actions = useComputeActions(async, () => {});
    actions.provision(compute);

    expect(async.ran.length).toBe(1);
    expect(async.ran[0].label).toBe("Provisioning prov-box");
  });

  it("provision does nothing when provider not found", () => {
    // Do NOT register any provider matching "nonexistent"
    const compute = createCompute({ name: "ghost-box", provider: "nonexistent" });

    const async = mockAsyncState();
    const logs: { name: string; message: string }[] = [];
    const actions = useComputeActions(async, (n, m) => logs.push({ name: n, message: m }));
    actions.provision(compute);

    expect(async.ran.length).toBe(0);
    expect(logs.length).toBe(0);
  });

  it("provision sets status to provisioning before run", () => {
    registerProvider(mockProvider("mock"));
    const compute = createCompute({ name: "status-box", provider: "mock" });

    const async = mockAsyncState();
    const actions = useComputeActions(async, () => {});
    actions.provision(compute);

    // updateCompute is called before run, so status should reflect it
    const updated = getCompute("status-box");
    expect(updated!.status).toBe("provisioning");
  });

  it("stop calls run with correct label", () => {
    registerProvider(mockProvider("mock"));
    const compute = createCompute({ name: "stop-box", provider: "mock" });

    const async = mockAsyncState();
    const actions = useComputeActions(async, () => {});
    actions.stop(compute);

    expect(async.ran.length).toBe(1);
    expect(async.ran[0].label).toBe("Stopping stop-box");
  });

  it("start calls run with correct label", () => {
    registerProvider(mockProvider("mock"));
    const compute = createCompute({ name: "start-box", provider: "mock" });

    const async = mockAsyncState();
    const actions = useComputeActions(async, () => {});
    actions.start(compute);

    expect(async.ran.length).toBe(1);
    expect(async.ran[0].label).toBe("Starting start-box");
  });

  it("provision calls addLog", () => {
    registerProvider(mockProvider("mock"));
    const compute = createCompute({ name: "log-prov", provider: "mock" });

    const async = mockAsyncState();
    const logs: { name: string; message: string }[] = [];
    const actions = useComputeActions(async, (n, m) => logs.push({ name: n, message: m }));
    actions.provision(compute);

    // addLog is called before run with "Starting provisioning..."
    const beforeRun = logs.find(l => l.message === "Starting provisioning...");
    expect(beforeRun).toBeDefined();
    expect(beforeRun!.name).toBe("log-prov");
  });

  it("stop calls addLog", () => {
    registerProvider(mockProvider("mock"));
    const compute = createCompute({ name: "log-stop", provider: "mock" });

    const async = mockAsyncState();
    const logs: { name: string; message: string }[] = [];
    const actions = useComputeActions(async, (n, m) => logs.push({ name: n, message: m }));
    actions.stop(compute);

    const entry = logs.find(l => l.message === "Stopping...");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("log-stop");
  });

  it("start calls addLog", () => {
    registerProvider(mockProvider("mock"));
    const compute = createCompute({ name: "log-start", provider: "mock" });

    const async = mockAsyncState();
    const logs: { name: string; message: string }[] = [];
    const actions = useComputeActions(async, (n, m) => logs.push({ name: n, message: m }));
    actions.start(compute);

    const entry = logs.find(l => l.message === "Starting...");
    expect(entry).toBeDefined();
    expect(entry!.name).toBe("log-start");
  });

  it("stop does nothing when provider not found", () => {
    const compute = createCompute({ name: "no-prov-stop", provider: "nonexistent" });

    const async = mockAsyncState();
    const logs: { name: string; message: string }[] = [];
    const actions = useComputeActions(async, (n, m) => logs.push({ name: n, message: m }));
    actions.stop(compute);

    expect(async.ran.length).toBe(0);
    expect(logs.length).toBe(0);
  });

  it("start does nothing when provider not found", () => {
    const compute = createCompute({ name: "no-prov-start", provider: "nonexistent" });

    const async = mockAsyncState();
    const logs: { name: string; message: string }[] = [];
    const actions = useComputeActions(async, (n, m) => logs.push({ name: n, message: m }));
    actions.start(compute);

    expect(async.ran.length).toBe(0);
    expect(logs.length).toBe(0);
  });

  it("clean calls run with 'Cleaning zombie sessions' label", () => {
    const async = mockAsyncState();
    const actions = useComputeActions(async, () => {});
    actions.clean();

    expect(async.ran.length).toBe(1);
    expect(async.ran[0].label).toBe("Cleaning zombie sessions");
  });
});
