/**
 * runTargetLifecycle tests. Covers:
 *   - compute-start, ensure-reachable, flush-secrets, prepare-workspace,
 *     isolation-prepare, launch-agent all fire in order
 *   - each step is gracefully skipped when its precondition isn't met
 *     (no method on Compute, no relevant opt, empty queue, running status)
 *   - provisioning_step events emitted with status: ok and the right
 *     step names, in the documented sequence
 *   - failures bubble out as ProvisionStepError with the failing step
 *     name in the message and stop subsequent steps
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../../../app.js";
import { runTargetLifecycle } from "../target-lifecycle.js";
import { DeferredPlacementCtx } from "../../../secrets/deferred-placement-ctx.js";
import type { AgentHandle, ComputeHandle, LaunchOpts, PrepareCtx } from "../../../compute/types.js";
import type { ComputeTarget } from "../../../compute/compute-target.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => {
  await app?.shutdown();
});

interface Calls {
  prepare: number;
  launch: number;
  start: number;
  ensureReachable: number;
  prepareWorkspace: number;
  flushPlacement: number;
  /** Ordered record of the step methods as they fire. */
  order: string[];
  /** Args captured at call time so tests can assert thread-through. */
  workspaceArgs?: { source: string | null; remoteWorkdir: string | null; sessionId: string };
  flushArgs?: { placementOps: number; sessionId: string };
}

interface FakeOpts {
  launchThrows?: boolean;
  prepareThrows?: boolean;
  ensureReachableThrows?: boolean;
  /** When true, the fake compute omits ensureReachable (as if the impl didn't ship it). */
  omitEnsureReachable?: boolean;
  /** When true, the fake compute omits prepareWorkspace. */
  omitPrepareWorkspace?: boolean;
  /** When true, the fake compute omits flushPlacement. */
  omitFlushPlacement?: boolean;
}

function fakeTarget(calls: Calls, opts: FakeOpts = {}): ComputeTarget {
  const compute: Record<string, unknown> = {
    start: async () => {
      calls.start += 1;
      calls.order.push("start");
    },
  };
  if (!opts.omitEnsureReachable) {
    compute.ensureReachable = async () => {
      calls.ensureReachable += 1;
      calls.order.push("ensure-reachable");
      if (opts.ensureReachableThrows) throw new Error("ensure boom");
    };
  }
  if (!opts.omitPrepareWorkspace) {
    compute.prepareWorkspace = async (
      _h: ComputeHandle,
      o: { source: string | null; remoteWorkdir: string | null; sessionId: string },
    ) => {
      calls.prepareWorkspace += 1;
      calls.order.push("prepare-workspace");
      calls.workspaceArgs = { source: o.source, remoteWorkdir: o.remoteWorkdir, sessionId: o.sessionId };
    };
  }
  if (!opts.omitFlushPlacement) {
    compute.flushPlacement = async (_h: ComputeHandle, o: { placement: DeferredPlacementCtx; sessionId: string }) => {
      calls.flushPlacement += 1;
      calls.order.push("flush-secrets");
      calls.flushArgs = { placementOps: o.placement.queuedOps.length, sessionId: o.sessionId };
    };
  }
  return {
    compute,
    async prepare(_h: ComputeHandle, _ctx: PrepareCtx): Promise<void> {
      calls.prepare += 1;
      calls.order.push("isolation-prepare");
      if (opts.prepareThrows) throw new Error("prepare boom");
    },
    async launchAgent(_h: ComputeHandle, _o: LaunchOpts): Promise<AgentHandle> {
      calls.launch += 1;
      calls.order.push("launch-agent");
      if (opts.launchThrows) throw new Error("launch boom");
      return { sessionName: "ark-test" };
    },
  } as unknown as ComputeTarget;
}

function newCalls(): Calls {
  return {
    prepare: 0,
    launch: 0,
    start: 0,
    ensureReachable: 0,
    prepareWorkspace: 0,
    flushPlacement: 0,
    order: [],
  };
}

const HANDLE: ComputeHandle = { kind: "local", name: "local", meta: {} };
const LAUNCH_OPTS: LaunchOpts = { tmuxName: "ark-test", workdir: "/tmp/x", launcherContent: "echo hi" };

describe("runTargetLifecycle", () => {
  test("calls prepare then launchAgent and returns the AgentHandle", async () => {
    const s = await app.sessions.create({ summary: "happy" });
    const calls = newCalls();
    const target = fakeTarget(calls);
    const result = await runTargetLifecycle(app, s.id, target, HANDLE, LAUNCH_OPTS);
    expect(calls.prepare).toBe(1);
    expect(calls.launch).toBe(1);
    expect(result.sessionName).toBe("ark-test");
  });

  test("emits provisioning_step events for isolation-prepare and launch-agent", async () => {
    const s = await app.sessions.create({ summary: "events" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS);

    const events = await app.events.list(s.id);
    const okSteps = events
      .filter((e: { type: string; data: unknown }) => e.type === "provisioning_step")
      .map((e: { data: { step?: string; status?: string } }) => e.data)
      .filter((d) => d.status === "ok")
      .map((d) => d.step);
    expect(okSteps).toContain("isolation-prepare");
    expect(okSteps).toContain("launch-agent");
  });

  test("rethrows ProvisionStepError when prepare fails", async () => {
    const s = await app.sessions.create({ summary: "prepare-fail" });
    const calls = newCalls();
    const target = fakeTarget(calls, { prepareThrows: true });
    await expect(runTargetLifecycle(app, s.id, target, HANDLE, LAUNCH_OPTS)).rejects.toThrow(/isolation-prepare.*boom/);
    // launch never ran because prepare failed.
    expect(calls.launch).toBe(0);
  });

  test("rethrows ProvisionStepError when launchAgent fails", async () => {
    const s = await app.sessions.create({ summary: "launch-fail" });
    const calls = newCalls();
    const target = fakeTarget(calls, { launchThrows: true });
    await expect(runTargetLifecycle(app, s.id, target, HANDLE, LAUNCH_OPTS)).rejects.toThrow(/launch-agent.*boom/);
  });

  test("calls compute.start when computeStatus is 'stopped'", async () => {
    const s = await app.sessions.create({ summary: "auto-start" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, { computeStatus: "stopped" });
    expect(calls.start).toBe(1);
    // start fires before ensure-reachable.
    expect(calls.order.indexOf("start")).toBeLessThan(calls.order.indexOf("ensure-reachable"));
  });

  test("skips compute.start when computeStatus is 'running'", async () => {
    const s = await app.sessions.create({ summary: "no-start" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, { computeStatus: "running" });
    expect(calls.start).toBe(0);
  });

  test("skips compute.start when autoStart is false", async () => {
    const s = await app.sessions.create({ summary: "auto-start-off" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, {
      computeStatus: "stopped",
      autoStart: false,
    });
    expect(calls.start).toBe(0);
  });

  test("calls ensureReachable when implemented", async () => {
    const s = await app.sessions.create({ summary: "ensure" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS);
    expect(calls.ensureReachable).toBe(1);
  });

  test("skips ensureReachable when the impl omits the method", async () => {
    const s = await app.sessions.create({ summary: "no-ensure" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls, { omitEnsureReachable: true }), HANDLE, LAUNCH_OPTS);
    expect(calls.ensureReachable).toBe(0);
    // Subsequent steps still ran.
    expect(calls.prepare).toBe(1);
    expect(calls.launch).toBe(1);
  });

  test("skips ensureReachable when ensureReachable opt is false", async () => {
    const s = await app.sessions.create({ summary: "ensure-off" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, { ensureReachable: false });
    expect(calls.ensureReachable).toBe(0);
  });

  test("calls prepareWorkspace with workspace opts", async () => {
    const s = await app.sessions.create({ summary: "workspace" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, {
      workspace: { source: "https://github.com/foo/bar.git", remoteWorkdir: "/home/ubuntu/Projects/x/bar" },
    });
    expect(calls.prepareWorkspace).toBe(1);
    expect(calls.workspaceArgs?.source).toBe("https://github.com/foo/bar.git");
    expect(calls.workspaceArgs?.remoteWorkdir).toBe("/home/ubuntu/Projects/x/bar");
    expect(calls.workspaceArgs?.sessionId).toBe(s.id);
  });

  test("skips prepareWorkspace when source is null", async () => {
    const s = await app.sessions.create({ summary: "no-source" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, {
      workspace: { source: null, remoteWorkdir: "/tmp/anywhere" },
    });
    expect(calls.prepareWorkspace).toBe(0);
  });

  test("skips prepareWorkspace when remoteWorkdir is null", async () => {
    const s = await app.sessions.create({ summary: "no-workdir" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, {
      workspace: { source: "https://github.com/foo/bar.git", remoteWorkdir: null },
    });
    expect(calls.prepareWorkspace).toBe(0);
  });

  test("skips prepareWorkspace when impl omits the method", async () => {
    const s = await app.sessions.create({ summary: "no-prepare-workspace-impl" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls, { omitPrepareWorkspace: true }), HANDLE, LAUNCH_OPTS, {
      workspace: { source: "https://x", remoteWorkdir: "/tmp/x" },
    });
    expect(calls.prepareWorkspace).toBe(0);
    expect(calls.prepare).toBe(1);
  });

  test("calls flushPlacement when placement is non-empty", async () => {
    const s = await app.sessions.create({ summary: "flush" });
    const calls = newCalls();
    const placement = new DeferredPlacementCtx();
    // Queue one writeFile op so hasDeferred() returns true.
    await placement.writeFile("/tmp/key", 0o600, new Uint8Array([1, 2, 3]));
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, { placement });
    expect(calls.flushPlacement).toBe(1);
    expect(calls.flushArgs?.placementOps).toBe(1);
    expect(calls.flushArgs?.sessionId).toBe(s.id);
  });

  test("skips flushPlacement when placement queue is empty", async () => {
    const s = await app.sessions.create({ summary: "flush-empty" });
    const calls = newCalls();
    const placement = new DeferredPlacementCtx();
    // No queued ops -- env-only session.
    placement.setEnv("FOO", "bar");
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, { placement });
    expect(calls.flushPlacement).toBe(0);
  });

  test("skips flushPlacement when placement opt is omitted", async () => {
    const s = await app.sessions.create({ summary: "no-placement" });
    const calls = newCalls();
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS);
    expect(calls.flushPlacement).toBe(0);
  });

  test("skips flushPlacement when impl omits the method", async () => {
    const s = await app.sessions.create({ summary: "no-flush-impl" });
    const calls = newCalls();
    const placement = new DeferredPlacementCtx();
    await placement.writeFile("/tmp/key", 0o600, new Uint8Array([1]));
    await runTargetLifecycle(app, s.id, fakeTarget(calls, { omitFlushPlacement: true }), HANDLE, LAUNCH_OPTS, {
      placement,
    });
    expect(calls.flushPlacement).toBe(0);
    expect(calls.prepare).toBe(1);
  });

  test("emits provisioning_step events for all six steps in order", async () => {
    const s = await app.sessions.create({ summary: "all-steps" });
    const calls = newCalls();
    const placement = new DeferredPlacementCtx();
    await placement.writeFile("/tmp/key", 0o600, new Uint8Array([9]));
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS, {
      computeStatus: "stopped",
      workspace: { source: "https://github.com/foo/bar.git", remoteWorkdir: "/home/ubuntu/Projects/x/bar" },
      placement,
    });

    // Confirm the per-step methods on the target fired in the documented
    // order. Note: flush-secrets sits BEFORE prepare-workspace because
    // the workspace clone uses the SSH key the placement just delivered
    // (matches legacy RemoteWorktreeProvider.launch ordering).
    expect(calls.order).toEqual([
      "start",
      "ensure-reachable",
      "flush-secrets",
      "prepare-workspace",
      "isolation-prepare",
      "launch-agent",
    ]);

    // And the provisioning_step events also land in that order on the
    // session timeline.
    const events = await app.events.list(s.id);
    const okSteps = events
      .filter((e: { type: string; data: unknown }) => e.type === "provisioning_step")
      .map((e: { data: { step?: string; status?: string } }) => e.data)
      .filter((d) => d.status === "ok")
      .map((d) => d.step);
    expect(okSteps).toEqual([
      "compute-start",
      "ensure-reachable",
      "flush-secrets",
      "prepare-workspace",
      "isolation-prepare",
      "launch-agent",
    ]);
  });

  test("stops at the first failed step", async () => {
    const s = await app.sessions.create({ summary: "fail-stops" });
    const calls = newCalls();
    const target = fakeTarget(calls, { ensureReachableThrows: true });
    await expect(
      runTargetLifecycle(app, s.id, target, HANDLE, LAUNCH_OPTS, {
        computeStatus: "stopped",
        workspace: { source: "https://x", remoteWorkdir: "/tmp/x" },
      }),
    ).rejects.toThrow(/ensure-reachable.*ensure boom/);
    // start fired before ensure-reachable; subsequent steps did not.
    expect(calls.start).toBe(1);
    expect(calls.ensureReachable).toBe(1);
    expect(calls.flushPlacement).toBe(0);
    expect(calls.prepareWorkspace).toBe(0);
    expect(calls.prepare).toBe(0);
    expect(calls.launch).toBe(0);
  });
});
