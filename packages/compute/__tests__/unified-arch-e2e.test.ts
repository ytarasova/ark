/**
 * End-to-end tests for the unified (Compute × Isolation) architecture.
 *
 * The other tests in this package cover each layer in isolation:
 *   - `compute-target.test.ts` — ComputeTarget delegation with fakes
 *   - `compute-target-pool.test.ts` — pool-consult routing with stubs
 *   - `local-compute.test.ts`, `direct-runtime.test.ts`,
 *     `docker-runtime.test.ts` — each piece on its own
 *   - `legacy-adapter.test.ts` — legacy-provider → target mapping (no exec)
 *
 * This file pins the cross-layer contract: driving a real `ComputeTarget`
 * through the full `provision → prepare → launchAgent → shutdown → destroy`
 * lifecycle for several real `(Compute, Isolation)` pairs, with stubs only
 * at the network edge (`ArkdClient`) and at the docker-helpers surface. The
 * goal is to prove that:
 *
 *   1. The composed target routes every lifecycle method to the right half.
 *   2. Swapping the Isolation on the same Compute selects a different
 *      launch URL (DirectIsolation hits `Compute.getArkdUrl`; DockerIsolation
 *      hits the per-container URL it stamps on `handle.meta.docker.arkdUrl`).
 *   3. The legacy-adapter output is not just well-typed — it is operational:
 *      the returned ComputeTarget runs exactly like one built by hand.
 *   4. Capability gates fire through ComputeTarget with the real
 *      `NotSupportedError`.
 *   5. `attachExistingHandle` produces a handle that can drive the full
 *      launch path without a prior `provision()` call (boot rehydration).
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";

import { ComputeTarget } from "../core/compute-target.js";
import { LocalCompute } from "../core/local.js";
import { DirectIsolation } from "../isolation/direct.js";
import { DockerIsolation } from "../isolation/docker.js";
import type { DockerIsolationHelpers, DockerHandleMeta } from "../isolation/docker.js";
import type { ComputeHandle, LaunchOpts } from "../core/types.js";
import { NotSupportedError } from "../core/types.js";
import type { ArkdClient } from "../../arkd/client.js";
import { computeProviderToTarget } from "../adapters/legacy.js";
import { LocalWorktreeProvider, LocalDockerProvider } from "../providers/local-arkd.js";
import { AppContext } from "../../core/app.js";
import { setApp, clearApp } from "../../core/__tests__/test-helpers.js";

let app: AppContext;

beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
  setApp(app);
});

afterAll(async () => {
  await app?.shutdown();
  clearApp();
});

// ── Shared stubs ─────────────────────────────────────────────────────────────

type LaunchCall = { url: string; sessionName: string; script: string; workdir: string };

function stubArkdClientFactory(record: LaunchCall[]): (url: string) => ArkdClient {
  return (url: string) =>
    ({
      launchAgent: async (req: { sessionName: string; script: string; workdir: string }) => {
        record.push({ url, ...req });
        return { ok: true } as unknown as never;
      },
    }) as unknown as ArkdClient;
}

function stubDockerHelpers(): { helpers: DockerIsolationHelpers; calls: Array<{ fn: string; args: unknown[] }> } {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ fn: name, args });
    };
  const helpers: DockerIsolationHelpers = {
    pullImage: record("pullImage") as DockerIsolationHelpers["pullImage"],
    createContainer: record("createContainer") as DockerIsolationHelpers["createContainer"],
    startContainer: record("startContainer") as DockerIsolationHelpers["startContainer"],
    stopContainer: record("stopContainer") as DockerIsolationHelpers["stopContainer"],
    removeContainer: record("removeContainer") as DockerIsolationHelpers["removeContainer"],
    bootstrapContainer: record("bootstrapContainer") as DockerIsolationHelpers["bootstrapContainer"],
    startArkdInContainer: record("startArkdInContainer") as DockerIsolationHelpers["startArkdInContainer"],
    waitForArkdHealth: record("waitForArkdHealth") as DockerIsolationHelpers["waitForArkdHealth"],
    resolveArkSourceRoot: (() => "/fake/ark/source") as DockerIsolationHelpers["resolveArkSourceRoot"],
    allocatePort: (async () => 59999) as DockerIsolationHelpers["allocatePort"],
  };
  return { helpers, calls };
}

function baseLaunchOpts(): LaunchOpts {
  return {
    tmuxName: "ark-s-unified",
    workdir: "/tmp/unified-work",
    launcherContent: "#!/bin/bash\necho unified",
  };
}

// ── 1. LocalCompute × DirectIsolation: full lifecycle through ComputeTarget ──

describe("unified-arch E2E: LocalCompute × DirectIsolation", async () => {
  it("drives provision → prepare → launchAgent → shutdown with the right URL", async () => {
    const compute = new LocalCompute(app);
    const isolation = new DirectIsolation(app);
    const target = new ComputeTarget(compute, isolation, app);

    const launches: LaunchCall[] = [];
    isolation.setClientFactory(stubArkdClientFactory(launches));

    const handle = await target.provision({ tags: { name: "local" } });
    expect(handle.kind).toBe("local");
    expect(handle.name).toBe("local");

    await target.prepare(handle, { workdir: "/tmp/unified-work" });

    const agent = await target.launchAgent(handle, baseLaunchOpts());
    expect(agent.sessionName).toBe("ark-s-unified");

    // URL comes from LocalCompute.getArkdUrl (not from anywhere on the isolation).
    expect(launches).toEqual([
      {
        url: `http://localhost:${app.config.ports.arkd}`,
        sessionName: "ark-s-unified",
        script: "#!/bin/bash\necho unified",
        workdir: "/tmp/unified-work",
      },
    ]);

    await target.shutdown(handle);
    // DirectIsolation.shutdown is a no-op — still exactly one client call.
    expect(launches).toHaveLength(1);
  });

  it("surfaces LocalCompute's NotSupportedError through ComputeTarget for start/stop/destroy", async () => {
    const target = new ComputeTarget(new LocalCompute(app), new DirectIsolation(app), app);
    const handle: ComputeHandle = { kind: "local", name: "local", meta: {} };
    (await expect(target.start(handle))).rejects.toBeInstanceOf(NotSupportedError);
    (await expect(target.stop(handle))).rejects.toBeInstanceOf(NotSupportedError);
    (await expect(target.destroy(handle))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("surfaces LocalCompute's NotSupportedError for snapshot/restore through ComputeTarget", async () => {
    const target = new ComputeTarget(new LocalCompute(app), new DirectIsolation(app), app);
    const handle: ComputeHandle = { kind: "local", name: "local", meta: {} };
    (await expect(target.snapshot(handle))).rejects.toBeInstanceOf(NotSupportedError);
    const snap = {
      id: "noop",
      computeKind: "local" as const,
      createdAt: new Date().toISOString(),
      sizeBytes: 0,
      metadata: {},
    };
    (await expect(target.restore(snap))).rejects.toBeInstanceOf(NotSupportedError);
  });

  it("getArkdUrl through ComputeTarget matches the underlying Compute", () => {
    const compute = new LocalCompute(app);
    const target = new ComputeTarget(compute, new DirectIsolation(app), app);
    const handle: ComputeHandle = { kind: "local", name: "local", meta: {} };
    expect(target.getArkdUrl(handle)).toBe(compute.getArkdUrl(handle));
    expect(target.getArkdUrl(handle)).toBe(`http://localhost:${app.config.ports.arkd}`);
  });
});

// ── 2. LocalCompute × DockerIsolation: composition selects the container URL ──

describe("unified-arch E2E: LocalCompute × DockerIsolation", async () => {
  it("swapping isolation on the same compute swaps the launch URL without touching compute state", async () => {
    const compute = new LocalCompute(app);

    // Direct target — launchAgent should hit the compute-level URL.
    const directIsolation = new DirectIsolation(app);
    const directTarget = new ComputeTarget(compute, directIsolation, app);
    const directLaunches: LaunchCall[] = [];
    directIsolation.setClientFactory(stubArkdClientFactory(directLaunches));

    const directHandle = await directTarget.provision({ tags: { name: "local" } });
    await directTarget.prepare(directHandle, { workdir: "/tmp/unified-work" });
    await directTarget.launchAgent(directHandle, baseLaunchOpts());

    // Docker target — launchAgent should hit the per-container URL the
    // isolation stamps on the handle during prepare.
    const dockerIsolation = new DockerIsolation(app);
    const { helpers } = stubDockerHelpers();
    dockerIsolation.setHelpersForTesting(helpers);
    const dockerLaunches: LaunchCall[] = [];
    dockerIsolation.setClientFactory(stubArkdClientFactory(dockerLaunches));
    const dockerTarget = new ComputeTarget(compute, dockerIsolation, app);

    const dockerHandle = await dockerTarget.provision({ tags: { name: "dockerized" } });
    expect(dockerHandle.name).toBe("dockerized");
    await dockerTarget.prepare(dockerHandle, { workdir: "/tmp/unified-work" });

    const meta = (dockerHandle.meta as Record<string, unknown>).docker as DockerHandleMeta;
    expect(meta).toBeDefined();
    expect(meta.containerName).toBe("ark-rt-dockerized");
    expect(meta.arkdHostPort).toBe(59999);

    await dockerTarget.launchAgent(dockerHandle, baseLaunchOpts());

    // Direct URL == compute URL; Docker URL == per-handle URL stamped in prepare.
    expect(directLaunches[0].url).toBe(`http://localhost:${app.config.ports.arkd}`);
    expect(dockerLaunches[0].url).toBe("http://localhost:59999");
    // The two URLs must differ — that's the core compositional claim.
    expect(directLaunches[0].url).not.toBe(dockerLaunches[0].url);
  });

  it("prepare runs the docker helpers in order and shutdown tears the container down", async () => {
    const compute = new LocalCompute(app);
    const isolation = new DockerIsolation(app);
    const { helpers, calls } = stubDockerHelpers();
    isolation.setHelpersForTesting(helpers);
    isolation.setClientFactory(stubArkdClientFactory([]));
    const target = new ComputeTarget(compute, isolation, app);

    const handle = await target.provision({ tags: { name: "lifecycle" } });
    await target.prepare(handle, { workdir: "/tmp/unified-work" });
    expect(calls.map((c) => c.fn)).toEqual([
      "pullImage",
      "createContainer",
      "startContainer",
      "bootstrapContainer",
      "startArkdInContainer",
      "waitForArkdHealth",
    ]);

    // Clear so we only observe shutdown's calls below.
    calls.length = 0;
    await target.shutdown(handle);
    expect(calls.map((c) => c.fn)).toEqual(["stopContainer", "removeContainer"]);
  });
});

// ── 3. Legacy adapter → ComputeTarget → runs end-to-end ──────────────────────

describe("unified-arch E2E: legacy adapter produces live ComputeTargets", async () => {
  it("LocalWorktreeProvider → ComputeTarget(LocalCompute, DirectIsolation) runs the full launch path", async () => {
    const legacy = new LocalWorktreeProvider(app);
    const target = computeProviderToTarget(legacy, app);
    if (!target) throw new Error("expected legacy adapter to produce a target");

    const isolation = target.isolation as DirectIsolation;
    const launches: LaunchCall[] = [];
    isolation.setClientFactory(stubArkdClientFactory(launches));

    const handle = await target.provision({ tags: { name: "legacy-local" } });
    await target.prepare(handle, { workdir: "/tmp/unified-work" });
    const agent = await target.launchAgent(handle, baseLaunchOpts());

    expect(agent.sessionName).toBe("ark-s-unified");
    expect(launches).toHaveLength(1);
    expect(launches[0].url).toBe(`http://localhost:${app.config.ports.arkd}`);
  });

  it("LocalDockerProvider → ComputeTarget(LocalCompute, DockerIsolation) routes through container URL", async () => {
    const legacy = new LocalDockerProvider(app);
    const target = computeProviderToTarget(legacy, app);
    if (!target) throw new Error("expected legacy adapter to produce a target");

    const isolation = target.isolation as DockerIsolation;
    const { helpers } = stubDockerHelpers();
    isolation.setHelpersForTesting(helpers);
    const launches: LaunchCall[] = [];
    isolation.setClientFactory(stubArkdClientFactory(launches));

    const handle = await target.provision({ tags: { name: "legacy-docker" } });
    await target.prepare(handle, { workdir: "/tmp/unified-work" });
    await target.launchAgent(handle, baseLaunchOpts());

    expect(launches).toHaveLength(1);
    // Docker handle meta drives the URL; compute's default URL is NOT used.
    expect(launches[0].url).toBe("http://localhost:59999");
    expect(launches[0].url).not.toBe(`http://localhost:${app.config.ports.arkd}`);
  });
});

// ── 4. Handle rehydration via attachExistingHandle ───────────────────────────

describe("unified-arch E2E: attachExistingHandle skips provision on rehydrate", async () => {
  it("LocalCompute.attachExistingHandle mints a handle that drives launchAgent without provision()", async () => {
    const compute = new LocalCompute(app);
    const isolation = new DirectIsolation(app);
    const target = new ComputeTarget(compute, isolation, app);

    const launches: LaunchCall[] = [];
    isolation.setClientFactory(stubArkdClientFactory(launches));

    // Synthesize a handle straight from a DB-shaped row (the boot-rehydrate path).
    const handle = compute.attachExistingHandle({
      name: "local",
      status: "running",
      config: { customField: "preserved" },
    });
    expect(handle).not.toBeNull();
    expect(handle!.kind).toBe("local");
    expect(handle!.name).toBe("local");
    expect((handle!.meta as Record<string, unknown>).customField).toBe("preserved");

    // No provision was called — go straight to prepare + launch.
    await target.prepare(handle!, { workdir: "/tmp/unified-work" });
    await target.launchAgent(handle!, baseLaunchOpts());

    expect(launches).toHaveLength(1);
    expect(launches[0].url).toBe(`http://localhost:${app.config.ports.arkd}`);
  });
});

// ── 5. Error propagation through the composed target ────────────────────────

describe("unified-arch E2E: error propagation", async () => {
  it("isolation errors bubble out of ComputeTarget.launchAgent", async () => {
    const isolation = new DirectIsolation(app);
    isolation.setClientFactory(
      () =>
        ({
          launchAgent: async () => {
            throw new Error("arkd unreachable");
          },
        }) as unknown as ArkdClient,
    );
    const target = new ComputeTarget(new LocalCompute(app), isolation, app);
    const handle = await target.provision({ tags: { name: "local" } });
    await target.prepare(handle, { workdir: "/tmp/unified-work" });
    (await expect(target.launchAgent(handle, baseLaunchOpts()))).rejects.toThrow("arkd unreachable");
  });

  it("docker prepare failures tear down the partially-created container", async () => {
    const isolation = new DockerIsolation(app);
    const { helpers, calls } = stubDockerHelpers();
    // Force bootstrap to fail after createContainer already ran.
    helpers.bootstrapContainer = (async () => {
      throw new Error("bootstrap blew up");
    }) as DockerIsolationHelpers["bootstrapContainer"];
    isolation.setHelpersForTesting(helpers);
    const target = new ComputeTarget(new LocalCompute(app), isolation, app);

    const handle = await target.provision({ tags: { name: "prep-fail" } });
    (await expect(target.prepare(handle, { workdir: "/tmp/unified-work" }))).rejects.toThrow("bootstrap blew up");

    // The isolation cleaned up the partially-created container.
    expect(calls.find((c) => c.fn === "createContainer")).toBeDefined();
    expect(calls.find((c) => c.fn === "removeContainer")).toBeDefined();
    // No docker meta was stamped on the handle (prepare bailed out).
    expect((handle.meta as Record<string, unknown>).docker).toBeUndefined();
  });
});
