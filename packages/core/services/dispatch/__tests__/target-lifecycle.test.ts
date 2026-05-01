/**
 * runTargetLifecycle tests. Covers:
 *   - prepare + launchAgent both fire in order
 *   - provisioning_step events emitted with status: ok and the right
 *     step names
 *   - failures bubble out as ProvisionStepError with the failing step
 *     name in the message
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../../../app.js";
import { runTargetLifecycle } from "../target-lifecycle.js";
import type { AgentHandle, ComputeHandle, LaunchOpts, PrepareCtx } from "../../../../compute/core/types.js";
import type { ComputeTarget } from "../../../../compute/core/compute-target.js";

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
}

function fakeTarget(calls: Calls, opts?: { launchThrows?: boolean; prepareThrows?: boolean }): ComputeTarget {
  return {
    async prepare(_h: ComputeHandle, _ctx: PrepareCtx): Promise<void> {
      calls.prepare += 1;
      if (opts?.prepareThrows) throw new Error("prepare boom");
    },
    async launchAgent(_h: ComputeHandle, _o: LaunchOpts): Promise<AgentHandle> {
      calls.launch += 1;
      if (opts?.launchThrows) throw new Error("launch boom");
      return { sessionName: "ark-test" };
    },
  } as unknown as ComputeTarget;
}

const HANDLE: ComputeHandle = { kind: "local", name: "local", meta: {} };
const LAUNCH_OPTS: LaunchOpts = { tmuxName: "ark-test", workdir: "/tmp/x", launcherContent: "echo hi" };

describe("runTargetLifecycle", () => {
  test("calls prepare then launchAgent and returns the AgentHandle", async () => {
    const s = await app.sessions.create({ summary: "happy" });
    const calls: Calls = { prepare: 0, launch: 0 };
    const target = fakeTarget(calls);
    const result = await runTargetLifecycle(app, s.id, target, HANDLE, LAUNCH_OPTS);
    expect(calls.prepare).toBe(1);
    expect(calls.launch).toBe(1);
    expect(result.sessionName).toBe("ark-test");
  });

  test("emits provisioning_step events for runtime-prepare and launch-agent", async () => {
    const s = await app.sessions.create({ summary: "events" });
    const calls: Calls = { prepare: 0, launch: 0 };
    await runTargetLifecycle(app, s.id, fakeTarget(calls), HANDLE, LAUNCH_OPTS);

    const events = await app.events.list(s.id);
    const okSteps = events
      .filter((e: { type: string; data: unknown }) => e.type === "provisioning_step")
      .map((e: { data: { step?: string; status?: string } }) => e.data)
      .filter((d) => d.status === "ok")
      .map((d) => d.step);
    expect(okSteps).toContain("runtime-prepare");
    expect(okSteps).toContain("launch-agent");
  });

  test("rethrows ProvisionStepError when prepare fails", async () => {
    const s = await app.sessions.create({ summary: "prepare-fail" });
    const calls: Calls = { prepare: 0, launch: 0 };
    const target = fakeTarget(calls, { prepareThrows: true });
    await expect(runTargetLifecycle(app, s.id, target, HANDLE, LAUNCH_OPTS)).rejects.toThrow(/runtime-prepare.*boom/);
    // launch never ran because prepare failed.
    expect(calls.launch).toBe(0);
  });

  test("rethrows ProvisionStepError when launchAgent fails", async () => {
    const s = await app.sessions.create({ summary: "launch-fail" });
    const calls: Calls = { prepare: 0, launch: 0 };
    const target = fakeTarget(calls, { launchThrows: true });
    await expect(runTargetLifecycle(app, s.id, target, HANDLE, LAUNCH_OPTS)).rejects.toThrow(/launch-agent.*boom/);
  });
});
