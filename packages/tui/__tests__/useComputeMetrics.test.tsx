/**
 * Tests for useComputeMetrics — polling metrics hook with log management.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { useComputeMetrics } from "../hooks/useComputeMetrics.js";
import { registerProvider, clearProviders } from "../../compute/index.js";
import { AppContext, setApp, clearApp } from "../../core/index.js";
import type { Compute } from "../../core/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let captured: ReturnType<typeof useComputeMetrics> | null = null;

function MetricsCapture({
  computes,
  active,
  pollMs,
}: {
  computes: Compute[];
  active: boolean;
  pollMs?: number;
}) {
  const metrics = useComputeMetrics(computes, active, pollMs);
  captured = metrics;
  return <Text>{`fetching=${metrics.fetching} snaps=${metrics.snapshots.size}`}</Text>;
}

function makeCompute(overrides: Partial<Compute> & { name: string; provider: string }): Compute {
  return {
    status: "stopped",
    size: "",
    arch: "",
    region: "",
    ip: "",
    keyName: "",
    instanceId: "",
    launchTemplate: "",
    tags: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Compute;
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
      metrics: {
        cpu: 42,
        memUsedGb: 4,
        memTotalGb: 16,
        memPct: 25,
        diskPct: 50,
        netRxMb: 10,
        netTxMb: 5,
        uptime: "1h",
        idleTicks: 0,
      },
      sessions: [],
      processes: [],
      docker: [],
    }),
    probePorts: async () => [],
    syncEnvironment: async () => {},
  };
}

// ── Setup ────────────────────────────────────────────────────────────────────

let app: AppContext;

beforeEach(async () => {
  captured = null;
  app = AppContext.forTest();
  await app.boot();
  setApp(app);
  clearProviders();
});

afterEach(async () => {
  clearProviders();
  if (app) await app.shutdown();
  clearApp();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("useComputeMetrics", () => {
  it("starts with empty snapshots and logs", () => {
    const computes: Compute[] = [];
    const { unmount } = render(
      <MetricsCapture computes={computes} active={false} />,
    );

    expect(captured).not.toBeNull();
    expect(captured!.snapshots.size).toBe(0);
    expect(captured!.logs.size).toBe(0);
    expect(captured!.fetching).toBe(false);
    unmount();
  });

  it("addLog appends timestamped entries (HH:MM:SS  message)", async () => {
    const computes: Compute[] = [];
    const { unmount } = render(
      <MetricsCapture computes={computes} active={false} />,
    );

    captured!.addLog("box-1", "booting up");
    await new Promise((r) => setTimeout(r, 50));

    const entries = captured!.logs.get("box-1");
    expect(entries).toBeDefined();
    expect(entries!.length).toBe(1);
    // Format: HH:MM:SS  message (two spaces between timestamp and message)
    expect(entries![0]).toMatch(/^\d{2}:\d{2}:\d{2}  booting up$/);
    unmount();
  });

  it("addLog caps at 50 entries (add 60, verify length=50, most recent kept)", async () => {
    const computes: Compute[] = [];
    const { unmount } = render(
      <MetricsCapture computes={computes} active={false} />,
    );

    for (let i = 0; i < 60; i++) {
      captured!.addLog("box-cap", `msg-${i}`);
    }
    await new Promise((r) => setTimeout(r, 100));

    const entries = captured!.logs.get("box-cap");
    expect(entries).toBeDefined();
    expect(entries!.length).toBe(50);
    // The earliest entries (0-9) should have been pruned; most recent kept
    expect(entries![entries!.length - 1]).toContain("msg-59");
    expect(entries![0]).toContain("msg-10");
    unmount();
  });

  it("does not fetch when inactive", async () => {
    let fetchCount = 0;
    const provider = mockProvider("track");
    const origGetMetrics = provider.getMetrics;
    provider.getMetrics = async (...args: any[]) => {
      fetchCount++;
      return origGetMetrics(...args);
    };
    registerProvider(provider as any);

    const computes = [
      makeCompute({ name: "idle-box", provider: "track", status: "running" }),
    ];
    const { unmount } = render(
      <MetricsCapture computes={computes} active={false} pollMs={50} />,
    );

    await new Promise((r) => setTimeout(r, 200));
    expect(fetchCount).toBe(0);
    expect(captured!.snapshots.size).toBe(0);
    unmount();
  });

  it("addLog works for multiple computes independently", async () => {
    const computes: Compute[] = [];
    const { unmount } = render(
      <MetricsCapture computes={computes} active={false} />,
    );

    captured!.addLog("alpha", "started");
    captured!.addLog("beta", "ready");
    captured!.addLog("alpha", "running task");
    await new Promise((r) => setTimeout(r, 50));

    const alphaEntries = captured!.logs.get("alpha");
    const betaEntries = captured!.logs.get("beta");

    expect(alphaEntries).toBeDefined();
    expect(betaEntries).toBeDefined();
    expect(alphaEntries!.length).toBe(2);
    expect(betaEntries!.length).toBe(1);
    expect(alphaEntries![0]).toContain("started");
    expect(alphaEntries![1]).toContain("running task");
    expect(betaEntries![0]).toContain("ready");
    unmount();
  });
});
