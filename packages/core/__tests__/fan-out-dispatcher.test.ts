/**
 * Unit tests for FanOutDispatcher.dispatchFork failure surfacing.
 *
 * Pre-fix: failed children were silently dropped (`if (result.ok) push`),
 * and a 0/N fan-out returned `{ok:true, message:"Forked into 0 sessions"}`
 * with the parent left waiting forever for an auto-join that would never
 * fire. Post-fix:
 *   - per-child failures emit a `fork_child_failed` event with the reason
 *   - 0/N fan-out returns `{ok:false}` so the kickDispatch + handoff paths
 *     mark the parent failed via markDispatchFailedShared.
 */

import { describe, it, expect } from "bun:test";
import { FanOutDispatcher } from "../services/dispatch/dispatch-fanout.js";
import type { Session } from "../../types/index.js";
import type { StageDefinition } from "../state/flow.js";

function makeStubSession(overrides?: Partial<Session>): Session {
  return {
    id: "s-parent",
    flow: "bare",
    stage: "implement",
    status: "ready",
    summary: "test parent",
    ticket: null,
    repo: null,
    workdir: null,
    branch: null,
    pr_url: null,
    agent: null,
    runtime: null,
    compute_name: null,
    fork_group: null,
    parent_id: null,
    group_name: null,
    config: null as any,
    error: null,
    breakpoint_reason: null,
    attached_by: null,
    session_id: null,
    claude_session_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    tenant_id: null,
    ...overrides,
  } as Session;
}

function makeDeps(opts: {
  session: Session;
  subtasks: Array<{ name: string; task: string }>;
  forkResults: Array<{ ok: true; sessionId: string } | { ok: false; message: string }>;
}) {
  const events: Array<{ type: string; data: any }> = [];
  const updates: Array<Partial<Session>> = [];
  let forkIdx = 0;

  const deps = {
    sessions: {
      get: async (_id: string) => opts.session,
      update: async (_id: string, patch: Partial<Session>) => {
        updates.push(patch);
      },
    } as any,
    events: {
      log: async (_sessionId: string, type: string, body: { data?: any }) => {
        events.push({ type, data: body?.data });
      },
    } as any,
    extractSubtasks: async () => opts.subtasks,
    fork: async () => {
      const r = opts.forkResults[forkIdx++];
      if (!r) return { ok: false as const, message: "no result configured" };
      return r;
    },
    dispatchChild: async () => ({ ok: true, message: "" }),
  };

  return { deps, events, updates };
}

const STAGE_DEF: StageDefinition = {
  name: "implement",
  type: "fork",
  max_parallel: 4,
} as StageDefinition;

describe("FanOutDispatcher.dispatchFork failure surfacing", () => {
  it("emits fork_child_failed event for each failed child with the reason", async () => {
    const session = makeStubSession();
    const { deps, events } = makeDeps({
      session,
      subtasks: [
        { name: "step-1", task: "do A" },
        { name: "step-2", task: "do B" },
        { name: "step-3", task: "do C" },
      ],
      forkResults: [
        { ok: true, sessionId: "child-1" },
        { ok: false, message: "fork blew up on B" },
        { ok: true, sessionId: "child-3" },
      ],
    });
    const dispatcher = new FanOutDispatcher(deps);

    const result = await dispatcher.dispatchFork(session.id, STAGE_DEF);

    // Mixed result: 2 ok + 1 failed -> still ok:true overall (some children
    // launched). Failures show up as events.
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Forked into 2 sessions");

    const childFailed = events.filter((e) => e.type === "fork_child_failed");
    expect(childFailed).toHaveLength(1);
    expect(childFailed[0].data.task).toBe("do B");
    expect(childFailed[0].data.reason).toContain("fork blew up on B");

    const forkStarted = events.find((e) => e.type === "fork_started");
    expect(forkStarted).toBeTruthy();
    expect(forkStarted!.data.children_count).toBe(2);
    expect(forkStarted!.data.failures_count).toBe(1);
    expect(forkStarted!.data.failures).toEqual(["fork blew up on B"]);
  });

  it("returns ok:false when ALL children fail (parent would otherwise wait forever)", async () => {
    const session = makeStubSession();
    const { deps, events } = makeDeps({
      session,
      subtasks: [
        { name: "step-1", task: "do A" },
        { name: "step-2", task: "do B" },
      ],
      forkResults: [
        { ok: false, message: "compute unreachable" },
        { ok: false, message: "compute unreachable" },
      ],
    });
    const dispatcher = new FanOutDispatcher(deps);

    const result = await dispatcher.dispatchFork(session.id, STAGE_DEF);

    // 0/2 success -> dispatch failed. The kickDispatch listener (or
    // mediateStageHandoff caller) sees ok:false and flips the parent
    // session to `failed` rather than leaving it stuck at `waiting`.
    expect(result.ok).toBe(false);
    expect(result.message).toContain("All 2 fork children failed");
    expect(result.message).toContain("compute unreachable");

    // Both per-child failures still recorded.
    expect(events.filter((e) => e.type === "fork_child_failed")).toHaveLength(2);
  });

  it("happy path: every child launches -> ok:true with no failures", async () => {
    const session = makeStubSession();
    const { deps, events } = makeDeps({
      session,
      subtasks: [
        { name: "step-1", task: "do A" },
        { name: "step-2", task: "do B" },
      ],
      forkResults: [
        { ok: true, sessionId: "child-1" },
        { ok: true, sessionId: "child-2" },
      ],
    });
    const dispatcher = new FanOutDispatcher(deps);

    const result = await dispatcher.dispatchFork(session.id, STAGE_DEF);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("Forked into 2 sessions");
    expect(events.filter((e) => e.type === "fork_child_failed")).toHaveLength(0);

    const forkStarted = events.find((e) => e.type === "fork_started");
    expect(forkStarted!.data.children_count).toBe(2);
    expect(forkStarted!.data.failures_count).toBe(0);
  });
});
