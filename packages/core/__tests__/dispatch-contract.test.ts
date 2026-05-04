/**
 * Dispatch contract: typed DispatchResult discriminated union.
 *
 * Pins the shape of `DispatchResult` at the helper boundaries that produce
 * the `launched:false` no-launch returns. The full integration paths
 * (CoreDispatcher.dispatch, kickDispatch post-condition) live in their
 * own test files; this one nails down the contract itself so a future
 * refactor that drops `launched` or `reason` fails loudly here.
 *
 * Covers:
 *   - validateSessionForDispatch: already-running short-circuit
 *   - maybeHandleActionStage: action-stage success
 *   - emitEmptyListComplete: empty for_each list
 *   - Type-shape compile-time assertions (ok:true+launched:true,
 *     ok:true+launched:false+reason, ok:false)
 */

import { describe, expect, it } from "bun:test";

import { validateSessionForDispatch, maybeHandleActionStage } from "../services/dispatch/guards.js";
import { emitEmptyListComplete } from "../services/dispatch/foreach/orchestration.js";
import type { DispatchResult } from "../services/dispatch/types.js";
import type { Session } from "../../types/index.js";

// Build a minimal session shape sufficient for the helpers under test.
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "s-test",
    summary: "test",
    flow: "test-flow",
    stage: "implement",
    status: "ready",
    agent: null,
    session_id: null,
    repo: null,
    branch: null,
    workdir: null,
    compute_name: null,
    config: {},
    error: null,
    rework_prompt: null,
    breakpoint_reason: null,
    tenant_id: "default",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as Session;
}

describe("DispatchResult contract", () => {
  it("validateSessionForDispatch already-running returns launched:false reason:already_running", async () => {
    const session = makeSession({ status: "running", session_id: "ark-s-test" });
    const deps = {
      sessions: { get: async () => session },
      computes: { get: async () => null },
    } as any;

    const out = await validateSessionForDispatch(deps, "s-test");
    expect(out.early).toBeDefined();
    const r = out.early!;
    expect(r.ok).toBe(true);
    if (r.ok === true) {
      expect(r.launched).toBe(false);
      if (r.launched === false) {
        expect(r.reason).toBe("already_running");
        expect(r.message).toContain("Already running");
      }
    }
  });

  it("maybeHandleActionStage action success returns launched:false reason:action_stage", async () => {
    const session = makeSession({ stage: "create_pr" });
    const updateAfterAction = makeSession({ stage: "create_pr", status: "ready" });
    const deps = {
      sessions: {
        get: async () => updateAfterAction,
        update: async () => {},
      },
      getStageAction: () => ({ type: "action" as const, action: "create_pr" }),
      executeAction: async () => ({ ok: true, message: "PR created" }),
      mediateStageHandoff: async () => undefined,
    } as any;

    const r = await maybeHandleActionStage(deps, session);
    expect(r).not.toBeNull();
    expect(r!.ok).toBe(true);
    if (r && r.ok === true) {
      expect(r.launched).toBe(false);
      if (r.launched === false) {
        expect(r.reason).toBe("action_stage");
        expect(r.message).toContain("Executed action 'create_pr'");
      }
    }
  });

  it("emitEmptyListComplete returns launched:false reason:for_each_empty_list", async () => {
    let logged: { sid: string; type: string } | null = null;
    let updated = false;
    const deps = {
      sessions: {
        get: async () => makeSession({ config: { for_each_checkpoint: null } }),
        mergeConfig: async () => {
          updated = true;
        },
      },
      events: {
        log: async (sid: string, type: string) => {
          logged = { sid, type };
        },
      },
    } as any;

    const r = await emitEmptyListComplete(deps, "s-test", "iterate");
    expect(r.ok).toBe(true);
    if (r.ok === true) {
      expect(r.launched).toBe(false);
      if (r.launched === false) {
        expect(r.reason).toBe("for_each_empty_list");
        expect(r.message).toContain("empty list");
      }
    }
    expect(logged).not.toBeNull();
    expect(logged!.type).toBe("for_each_complete");
    expect(updated).toBe(true);
  });

  it("type-shape: ok:true + launched:true is assignable", () => {
    const r: DispatchResult = { ok: true, launched: true, message: "ark-s-abc" };
    expect(r.ok).toBe(true);
    if (r.ok === true && r.launched === true) {
      expect(r.message).toBe("ark-s-abc");
    }
  });

  it("type-shape: ok:true + launched:false + reason is assignable", () => {
    const r: DispatchResult = {
      ok: true,
      launched: false,
      reason: "fork_parent",
      message: "Forked into 3 sessions",
    };
    expect(r.ok).toBe(true);
    if (r.ok === true && r.launched === false) {
      expect(r.reason).toBe("fork_parent");
      expect(r.message).toBe("Forked into 3 sessions");
    }
  });

  it("type-shape: ok:false has no launched field (just message)", () => {
    const r: DispatchResult = { ok: false, message: "compute unreachable" };
    expect(r.ok).toBe(false);
    if (r.ok === false) {
      expect(r.message).toBe("compute unreachable");
      // @ts-expect-error -- ok:false variant has no `launched` field by design
      expect(r.launched).toBeUndefined();
    }
  });
});
