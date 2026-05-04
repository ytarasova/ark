/**
 * Verifies that when advanceLinear / advanceGraph transitions to a next stage,
 * the previous stage's status poller is stopped BEFORE the session row is
 * updated. Without the explicit stop the poller polls a stale handle until it
 * self-terminates on the mismatch guard inside status-poller.ts.
 */
import { describe, it, expect } from "bun:test";
import { StageAdvancer } from "../advance.js";
import type { StageAdvanceDeps } from "../types.js";

interface TraceableDeps extends StageAdvanceDeps {
  _stopCalls: string[];
  _updateCalls: string[];
}

function makeDeps(overrides: Partial<StageAdvanceDeps> = {}): TraceableDeps {
  const session: any = {
    id: "s1",
    flow: "test-flow",
    stage: "stage-a",
    status: "running",
    session_id: "tmux-handle-123",
    agent: "test-agent",
    compute_name: null,
    tenant_id: "default",
    config: {},
    updated_at: new Date().toISOString(),
  };

  const stopCalls: string[] = [];
  const updateCalls: string[] = [];

  // No-op idempotency: db.prepare(...).run() / .get() / .all() return undefined
  // / null. withIdempotency only touches the table when an idempotencyKey is
  // present, which we don't pass below.
  const noopStmt: any = { run: () => undefined, get: () => null, all: () => [] };
  const db: any = { prepare: () => noopStmt };

  const deps: any = {
    sessions: {
      get: async () => session,
      update: async (id: string) => {
        updateCalls.push(id);
      },
    },
    events: { log: async () => {} },
    messages: { markRead: async () => {} },
    todos: { list: async () => [] },
    flowStates: {
      load: async () => null,
      markStageCompleted: async () => {},
      setCurrentStage: async () => {},
      markStagesSkipped: async () => {},
    },
    flows: {
      get: () => ({
        name: "test-flow",
        stages: [
          { name: "stage-a", agent: "test-agent" },
          { name: "stage-b", agent: "test-agent" },
        ],
      }),
    },
    runtimes: {},
    transcriptParsers: {},
    usageRecorder: {
      getSessionCost: async () => ({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost: 0 }),
    },
    config: { dirs: { worktrees: "/tmp" } },
    db,
    dispatch: async () => ({ ok: true, message: "ok" }),
    executeAction: async () => ({ ok: true, message: "ok" }),
    runVerification: async () => ({ ok: true, message: "ok" }),
    recordSessionUsage: () => {},
    sessionClone: async () => ({ ok: true, sessionId: "s2" }),
    capturePlanMd: async () => {},
    gcComputeIfTemplate: async () => false,
    extractAndSaveSkills: async () => {},
    saveCheckpoint: async () => {},
    getStage: (_flow: string, stageName: string) => ({ name: stageName, isolation: "fresh" }),
    getStageAction: (_flow: string, _stageName: string) => ({ type: "agent", agent: "test-agent" }),
    resolveNextStage: () => "stage-b",
    evaluateGate: () => ({ canProceed: true, reason: "" }),
    stopStatusPoller: (sessionId: string) => {
      stopCalls.push(sessionId);
    },
    ...overrides,
  };
  Object.defineProperty(deps, "_stopCalls", { value: stopCalls, enumerable: false });
  Object.defineProperty(deps, "_updateCalls", { value: updateCalls, enumerable: false });
  return deps as TraceableDeps;
}

describe("StageAdvancer.advance -- poller stop ordering", () => {
  it("stops the poller BEFORE updating the session row", async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      stopStatusPoller: (sessionId) => {
        callOrder.push(`stop:${sessionId}`);
      },
    });
    const origUpdate = deps.sessions.update;
    deps.sessions.update = async (id: string, patch: any) => {
      callOrder.push(`update:${id}`);
      return origUpdate(id, patch);
    };

    const advancer = new StageAdvancer(deps);
    const result = await advancer.advanceImpl("s1", true, undefined);

    expect(result.ok).toBe(true);
    const stopIdx = callOrder.findIndex((e) => e.startsWith("stop:"));
    const updateIdx = callOrder.findIndex((e) => e.startsWith("update:"));
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(stopIdx);
  });

  it("works without stopStatusPoller (backward compat)", async () => {
    const deps = makeDeps({ stopStatusPoller: undefined });
    const advancer = new StageAdvancer(deps);
    const result = await advancer.advanceImpl("s1", true, undefined);
    expect(result.ok).toBe(true);
  });
});
