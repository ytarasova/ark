/**
 * Lifecycle GC tests.
 *
 * Validates that template-lifecycle compute rows (k8s, firecracker, docker)
 * get garbage-collected when no live sessions reference them, while
 * persistent-lifecycle rows (local, ec2) stick around regardless.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AppContext } from "../../app.js";
import { garbageCollectComputeIfTemplate } from "../compute-lifecycle.js";
import type { ComputeProvider } from "../../../compute/types.js";

// A minimal provider stub used to exercise the `canDelete=false` branch in
// the GC path. Registered under a unique name per test to avoid clobbering
// the default registry entries (docker/local/k8s/...).
function makeStubProvider(overrides: Partial<ComputeProvider> & { name: string }): ComputeProvider {
  return {
    isolationModes: [],
    singleton: false,
    canReboot: false,
    canDelete: true,
    supportsWorktree: false,
    initialStatus: "stopped",
    needsAuth: false,
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
    ...overrides,
  };
}

let app: AppContext;

beforeEach(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});

afterEach(async () => {
  await app?.shutdown();
});

describe("garbageCollectComputeIfTemplate", () => {
  it("returns false when computeName is null/undefined/missing", async () => {
    expect(await garbageCollectComputeIfTemplate(app, null)).toBe(false);
    expect(await garbageCollectComputeIfTemplate(app, undefined)).toBe(false);
    expect(await garbageCollectComputeIfTemplate(app, "no-such")).toBe(false);
  });

  it("never gc's persistent-lifecycle (local) compute", async () => {
    expect(await garbageCollectComputeIfTemplate(app, "local")).toBe(false);
    expect(await app.computes.get("local")).not.toBeNull();
  });

  it("gc's template-lifecycle (k8s) compute when no sessions reference it", async () => {
    await app.computeService.create({
      name: "test-k8s",
      compute: "k8s",
      isolation: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
    });
    expect(await app.computes.get("test-k8s")).not.toBeNull();

    const gc = await garbageCollectComputeIfTemplate(app, "test-k8s");
    expect(gc).toBe(true);
    expect(await app.computes.get("test-k8s")).toBeNull();
  });

  it("skips gc when a live session still references the compute", async () => {
    await app.computeService.create({
      name: "busy-k8s",
      compute: "k8s",
      isolation: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
    });
    const session = await app.sessions.create({
      repo: "/tmp",
      flow: "quick",
      task: "test",
      agent: "default",
      compute_name: "busy-k8s",
    });
    // Default status from create is "ready" -- not terminal, so gc must skip.
    expect(["ready", "running", "pending", "paused", "waiting"]).toContain(session.status);

    const gc = await garbageCollectComputeIfTemplate(app, "busy-k8s");
    expect(gc).toBe(false);
    expect(await app.computes.get("busy-k8s")).not.toBeNull();
  });

  it("gc's after the referencing session reaches a terminal state", async () => {
    await app.computeService.create({
      name: "ephemeral-k8s",
      compute: "k8s",
      isolation: "direct",
      config: { context: "ctx", namespace: "ns", image: "img" },
    });
    const session = await app.sessions.create({
      repo: "/tmp",
      flow: "quick",
      task: "test",
      agent: "default",
      compute_name: "ephemeral-k8s",
    });
    // Mark the session completed -- now gc must succeed.
    await app.sessions.update(session.id, { status: "completed" });

    const gc = await garbageCollectComputeIfTemplate(app, "ephemeral-k8s");
    expect(gc).toBe(true);
    expect(await app.computes.get("ephemeral-k8s")).toBeNull();
  });

  it("local + docker (template isolation over persistent kind) gets gc'd", async () => {
    await app.computeService.create({
      name: "local-docker",
      compute: "local",
      isolation: "docker",
      config: { image: "alpine" },
    });
    const gc = await garbageCollectComputeIfTemplate(app, "local-docker");
    expect(gc).toBe(true);
    expect(await app.computes.get("local-docker")).toBeNull();
  });

  it("cloned_from rows are GC'd even when the kind is persistent", async () => {
    // EC2 + direct is persistent -- would normally be skipped. But the
    // `cloned_from` flag marks this row as an ephemeral clone produced by
    // the dispatcher, so GC should remove it regardless of lifecycle.
    await app.computeService.create({
      name: "ec2-clone",
      compute: "ec2",
      isolation: "direct",
      config: {},
      cloned_from: "ec2-template",
    });
    const gc = await garbageCollectComputeIfTemplate(app, "ec2-clone");
    expect(gc).toBe(true);
    expect(await app.computes.get("ec2-clone")).toBeNull();
  });

  it("persistent row WITHOUT cloned_from is NOT GC'd", async () => {
    // A user-provisioned EC2 box (no clone marker) should stick around
    // across session boundaries -- that's the whole point of persistent
    // infra. GC must leave it alone.
    await app.computeService.create({
      name: "ec2-persistent",
      compute: "ec2",
      isolation: "direct",
      config: {},
    });
    const gc = await garbageCollectComputeIfTemplate(app, "ec2-persistent");
    expect(gc).toBe(false);
    expect(await app.computes.get("ec2-persistent")).not.toBeNull();
  });

  // ── P0-1: GC must honour provider.canDelete for non-clone rows ──────────
  //
  // Before the P0-1 fix, GC called `app.computes.delete()` directly, skipping
  // the `canDelete` guard installed in `ComputeService.delete()`. A row whose
  // provider advertises `canDelete=false` was reaped anyway. The fix routes
  // non-clone deletions through `ComputeService.delete()` and only clones
  // bypass the guard via the narrow `forceDeleteClone()` helper.

  it("does NOT gc a template-lifecycle row when provider.canDelete=false (non-clone)", async () => {
    // Register a stub provider that's template-lifecycle (k8s+direct) but
    // refuses deletion. This simulates a provider class that manages
    // infrastructure externally -- deleting the row through GC would leak
    // the external resource. The service-layer canDelete guard must kick in
    // and the GC helper must swallow the resulting error and return false.
    // Provider name must match what `providerOf({compute_kind, isolation_kind})`
    // returns -- the registry is keyed by the legacy provider name derived
    // from the two-axis kinds, NOT by the row's `provider` column. For
    // {compute_kind:"k8s", isolation_kind:"direct"} that's "k8s". Registering
    // under "k8s" just shadows the production K8s provider for this app
    // instance.
    app.registerProvider(makeStubProvider({ name: "k8s", canDelete: false }));
    await app.computeService.create({
      name: "stub-row",
      provider: "k8s" as any,
      compute: "k8s",
      isolation: "direct",
      config: {},
    });

    const gc = await garbageCollectComputeIfTemplate(app, "stub-row");
    expect(gc).toBe(false);
    // Row must still exist: the canDelete=false guard protected it.
    expect(await app.computes.get("stub-row")).not.toBeNull();
  });

  it("DOES gc a clone row even when provider.canDelete=false (force-delete bypass)", async () => {
    // Contrast with the previous test: same provider (canDelete=false), but
    // the row is a clone. Clones are ephemeral by construction -- the GC
    // sweep uses `ComputeService.forceDeleteClone()` to bypass the guard
    // for clone rows only. Non-clone rows still refuse deletion.
    app.registerProvider(makeStubProvider({ name: "stub-nodelete-2", canDelete: false }));

    // Template parent first (is_template exempts it from the singleton / GC
    // paths so we can keep it around as a blueprint).
    await app.computeService.create({
      name: "stub-parent",
      provider: "stub-nodelete-2" as any,
      compute: "k8s",
      isolation: "direct",
      is_template: true,
      config: {},
    });
    // Clone of the parent.
    await app.computeService.create({
      name: "stub-clone",
      provider: "stub-nodelete-2" as any,
      compute: "k8s",
      isolation: "direct",
      cloned_from: "stub-parent",
      config: {},
    });

    const gc = await garbageCollectComputeIfTemplate(app, "stub-clone");
    expect(gc).toBe(true);
    expect(await app.computes.get("stub-clone")).toBeNull();
    // Parent template is NOT touched by GC (is_template short-circuits the
    // helper well before it gets anywhere near delete()).
    expect(await app.computes.get("stub-parent")).not.toBeNull();
  });
});
