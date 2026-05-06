/**
 * DockerIsolation unit tests.
 *
 * The runtime wraps a small docker-helpers surface + an `ArkdClient` factory;
 * both are swapped out in the tests via `setHelpersForTesting` and
 * `setClientFactory`. No `execFile` or `fetch` calls are made -- the stubs
 * record arguments so we can assert on the exact lifecycle order.
 */

import { describe, it, expect } from "bun:test";

import { DockerIsolation } from "../isolation/docker.js";
import { LocalCompute } from "../core/local.js";
import type { ComputeHandle, LaunchOpts, PrepareCtx } from "../core/types.js";
import type { ArkdClient } from "../../../arkd/client/index.js";
import type { DockerIsolationHelpers, DockerHandleMeta } from "../isolation/docker.js";
import type { AppContext } from "../../app.js";

// Minimal fake AppContext -- the DockerIsolation only reads config.dirs.ark +
// config.ports.conductor during prepare(). We don't need a real boot.
const fakeApp = {
  config: {
    dirs: { ark: "/tmp/ark" },
    ports: { conductor: 19100 },
  },
} as unknown as AppContext;

// ── Test doubles ─────────────────────────────────────────────────────────────

type Call = { fn: string; args: unknown[] };

function makeHelpers(overrides: Partial<DockerIsolationHelpers> = {}): {
  helpers: DockerIsolationHelpers;
  calls: Call[];
} {
  const calls: Call[] = [];
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
    allocatePort: (async () => 45678) as DockerIsolationHelpers["allocatePort"],
    ...overrides,
  };
  return { helpers, calls };
}

type LaunchCall = { sessionName: string; script: string; workdir: string };

function stubClient(record: LaunchCall[] | null, throwOnLaunch?: Error): ArkdClient {
  const client = {
    launchAgent: async (req: LaunchCall) => {
      if (throwOnLaunch) throw throwOnLaunch;
      record?.push({ sessionName: req.sessionName, script: req.script, workdir: req.workdir });
      return { ok: true } as unknown as never;
    },
  } as unknown as ArkdClient;
  return client;
}

function makeCompute(): LocalCompute {
  return new LocalCompute(fakeApp);
}

function makeHandle(name = "docker-test"): ComputeHandle {
  return { kind: "local", name, meta: {} };
}

function prepareCtx(overrides: Partial<PrepareCtx> = {}): PrepareCtx {
  return { workdir: "/tmp/work", ...overrides };
}

function launchOpts(): LaunchOpts {
  return {
    tmuxName: "ark-s-docker",
    workdir: "/tmp/work",
    launcherContent: "#!/bin/bash\necho hello",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DockerIsolation", async () => {
  it("has kind=docker and matching name", () => {
    const r = new DockerIsolation(fakeApp);
    expect(r.kind).toBe("docker");
    expect(r.name).toBe("docker");
  });

  describe("prepare", async () => {
    it("runs pull -> create -> start -> bootstrap -> startArkd -> waitForHealth in order", async () => {
      const { helpers, calls } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(makeCompute(), handle, prepareCtx());

      const order = calls.map((c) => c.fn);
      expect(order).toEqual([
        "pullImage",
        "createContainer",
        "startContainer",
        "bootstrapContainer",
        "startArkdInContainer",
        "waitForArkdHealth",
      ]);
    });

    it("stores containerName / arkdHostPort / arkdUrl / image / arkSource / tempPaths on handle.meta.docker", async () => {
      const { helpers } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle("my-compute");
      await r.prepare(makeCompute(), handle, prepareCtx());

      const meta = (handle.meta as Record<string, unknown>).docker as DockerHandleMeta;
      expect(meta).toBeDefined();
      expect(meta.containerName).toBe("ark-rt-my-compute");
      expect(meta.arkdHostPort).toBe(45678);
      expect(meta.arkdUrl).toBe("http://localhost:45678");
      expect(meta.image).toBe("ubuntu:22.04");
      expect(meta.arkSource).toBe("/fake/ark/source");
      expect(meta.tempPaths).toEqual([]);
    });

    it("honours ctx.config.image override", async () => {
      const { helpers, calls } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(makeCompute(), handle, prepareCtx({ config: { image: "alpine:3.20" } }));

      const pullCall = calls.find((c) => c.fn === "pullImage")!;
      expect(pullCall.args[0]).toBe("alpine:3.20");
      const createCall = calls.find((c) => c.fn === "createContainer")!;
      expect(createCall.args[1]).toBe("alpine:3.20");
      const meta = (handle.meta as Record<string, unknown>).docker as DockerHandleMeta;
      expect(meta.image).toBe("alpine:3.20");
    });

    it("forwards extraVolumes + bootstrap opts + arkSource to createContainer / bootstrapContainer", async () => {
      const { helpers, calls } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(
        makeCompute(),
        handle,
        prepareCtx({
          config: {
            volumes: ["/host/cache:/cache:rw"],
            bootstrap: { skip: true },
          },
        }),
      );

      const createCall = calls.find((c) => c.fn === "createContainer")!;
      const createOpts = createCall.args[2] as {
        extraVolumes: string[];
        arkSource: string;
        arkdHostPort: number;
        workdir: string;
      };
      expect(createOpts.extraVolumes).toEqual(["/host/cache:/cache:rw"]);
      expect(createOpts.arkSource).toBe("/fake/ark/source");
      expect(createOpts.arkdHostPort).toBe(45678);
      expect(createOpts.workdir).toBe("/tmp/work");

      const bootstrapCall = calls.find((c) => c.fn === "bootstrapContainer")!;
      expect(bootstrapCall.args[1]).toEqual({ skip: true });
    });

    it("throws if resolveArkSourceRoot returns null", async () => {
      const { helpers } = makeHelpers({ resolveArkSourceRoot: () => null });
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      (await expect(r.prepare(makeCompute(), makeHandle(), prepareCtx()))).rejects.toThrow(/ark source tree/);
    });

    it("cleans up the partially-created container if a later step fails", async () => {
      const bootstrapErr = new Error("bootstrap blew up");
      const { helpers, calls } = makeHelpers({
        bootstrapContainer: (async () => {
          throw bootstrapErr;
        }) as DockerIsolationHelpers["bootstrapContainer"],
      });
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      (await expect(r.prepare(makeCompute(), handle, prepareCtx()))).rejects.toThrow("bootstrap blew up");

      // Container was created then startContainer ran -- cleanup must remove it.
      expect(calls.find((c) => c.fn === "createContainer")).toBeDefined();
      expect(calls.find((c) => c.fn === "removeContainer")).toBeDefined();
      // handle.meta.docker must NOT be populated on failure.
      expect((handle.meta as Record<string, unknown>).docker).toBeUndefined();
    });

    it("does not attempt cleanup if createContainer itself fails", async () => {
      const createErr = new Error("docker create failed");
      const { helpers, calls } = makeHelpers({
        createContainer: (async () => {
          throw createErr;
        }) as DockerIsolationHelpers["createContainer"],
      });
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      (await expect(r.prepare(makeCompute(), makeHandle(), prepareCtx()))).rejects.toThrow("docker create failed");
      // Nothing to remove: container was never created.
      expect(calls.find((c) => c.fn === "removeContainer")).toBeUndefined();
    });

    it("propagates waitForArkdHealth failure and tears down the container", async () => {
      const healthErr = new Error("arkd never came up");
      const { helpers, calls } = makeHelpers({
        waitForArkdHealth: (async () => {
          throw healthErr;
        }) as DockerIsolationHelpers["waitForArkdHealth"],
      });
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      (await expect(r.prepare(makeCompute(), makeHandle(), prepareCtx()))).rejects.toThrow("arkd never came up");
      expect(calls.find((c) => c.fn === "removeContainer")).toBeDefined();
    });
  });

  describe("launchAgent", async () => {
    it("delegates to ArkdClient.launchAgent with tmuxName / script / workdir", async () => {
      const { helpers } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(makeCompute(), handle, prepareCtx());

      const launches: LaunchCall[] = [];
      r.setClientFactory(() => stubClient(launches));

      const h = await r.launchAgent(makeCompute(), handle, launchOpts());
      expect(h.sessionName).toBe("ark-s-docker");
      expect(launches).toEqual([
        { sessionName: "ark-s-docker", script: "#!/bin/bash\necho hello", workdir: "/tmp/work" },
      ]);
    });

    it("resolves the arkd URL from handle.meta.docker.arkdUrl", async () => {
      const { helpers } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(makeCompute(), handle, prepareCtx());

      const urls: string[] = [];
      r.setClientFactory((url) => {
        urls.push(url);
        return stubClient([]);
      });

      await r.launchAgent(makeCompute(), handle, launchOpts());
      expect(urls).toEqual(["http://localhost:45678"]);
    });

    it("throws if called before prepare", async () => {
      const r = new DockerIsolation(fakeApp);
      r.setClientFactory(() => stubClient([]));
      (await expect(r.launchAgent(makeCompute(), makeHandle(), launchOpts()))).rejects.toThrow(
        /handle\.meta\.docker missing/,
      );
    });

    it("propagates arkd errors", async () => {
      const { helpers } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(makeCompute(), handle, prepareCtx());
      r.setClientFactory(() => stubClient(null, new Error("arkd down")));
      (await expect(r.launchAgent(makeCompute(), handle, launchOpts()))).rejects.toThrow("arkd down");
    });
  });

  describe("shutdown", async () => {
    it("stops + removes the container", async () => {
      const { helpers, calls } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(makeCompute(), handle, prepareCtx());

      // Forget the prepare calls -- we only care about shutdown ordering.
      calls.length = 0;

      await r.shutdown(makeCompute(), handle);
      const order = calls.map((c) => c.fn);
      expect(order).toEqual(["stopContainer", "removeContainer"]);
      const stopCall = calls.find((c) => c.fn === "stopContainer")!;
      expect(stopCall.args[0]).toBe("ark-rt-docker-test");
    });

    it("is a no-op if prepare never ran (meta missing)", async () => {
      const { helpers, calls } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      await r.shutdown(makeCompute(), makeHandle());
      expect(calls).toEqual([]);
    });

    it("swallows stopContainer failures and still calls removeContainer", async () => {
      const { helpers, calls } = makeHelpers({
        stopContainer: (async () => {
          throw new Error("already stopped");
        }) as DockerIsolationHelpers["stopContainer"],
      });
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(makeCompute(), handle, prepareCtx());
      calls.length = 0;

      await r.shutdown(makeCompute(), handle);
      // stop threw, but remove still ran
      expect(calls.find((c) => c.fn === "removeContainer")).toBeDefined();
    });

    it("cleans up tempPaths on shutdown", async () => {
      const { helpers } = makeHelpers();
      const r = new DockerIsolation(fakeApp);
      r.setHelpersForTesting(helpers);

      const handle = makeHandle();
      await r.prepare(makeCompute(), handle, prepareCtx());

      // Inject a non-existent path -- rmSync with force:true treats missing paths as success.
      const meta = (handle.meta as Record<string, unknown>).docker as DockerHandleMeta;
      meta.tempPaths.push("/tmp/ark-runtime-nonexistent-xyz-12345");

      // Should not throw.
      await r.shutdown(makeCompute(), handle);
    });
  });
});
