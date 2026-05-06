/**
 * DockerComposeIsolation unit tests.
 *
 * All Docker interactions are stubbed via the runtime's `hooks` surface so
 * the tests can run without a real Docker daemon. We assert:
 *   - prepare() resolves the workspace's `docker-compose.yml` and passes it
 *     to composeUpWithFiles, then runs the sidecar lifecycle.
 *   - shutdown() stops/removes the sidecar and runs `docker compose down`.
 *   - shutdown() tolerates a failing `docker compose down`.
 *   - A sidecar-bootstrap failure (or compose up failure) rolls back cleanly.
 *   - prepare() throws clearly when no compose file exists in the workdir.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DockerComposeIsolation, type DockerComposeMeta } from "../isolation/docker-compose.js";
import { LocalCompute } from "../core/local.js";
import type { ComputeHandle, PrepareCtx } from "../core/types.js";
import type { AppContext } from "../../app.js";

const fakeApp = {
  config: { dirs: { ark: "/tmp/ark" }, ports: { arkd: 19300, conductor: 19100 } },
} as unknown as AppContext;

// ── Hook recorder ───────────────────────────────────────────────────────────

interface HookCalls {
  pull: string[];
  create: Array<{ name: string; image: string; opts: unknown }>;
  start: string[];
  stop: string[];
  remove: string[];
  bootstrap: Array<{ name: string; opts: unknown }>;
  startArkd: Array<{ name: string; url: string }>;
  waitArkd: Array<{ url: string; timeout?: number }>;
  composeUp: Array<{ workdir: string; files: string[] }>;
  composeDown: Array<{ workdir: string; files: string[] }>;
  resolveNet: Array<{ workdir: string; files?: string[] }>;
  connectNet: Array<{ network: string; container: string }>;
  allocated: number[];
}

function freshCalls(): HookCalls {
  return {
    pull: [],
    create: [],
    start: [],
    stop: [],
    remove: [],
    bootstrap: [],
    startArkd: [],
    waitArkd: [],
    composeUp: [],
    composeDown: [],
    resolveNet: [],
    connectNet: [],
    allocated: [],
  };
}

interface HookOverrides {
  composeUpOk?: boolean;
  composeDownOk?: boolean;
  composeUpError?: string;
  bootstrapThrows?: Error;
  waitThrows?: Error;
  arkSourceNull?: boolean;
  networkName?: string;
  portSeed?: number;
}

/**
 * Build a runtime preloaded with stubbed hooks. Returns both the runtime and
 * the call recorder so tests can assert on exact arguments.
 */
function makeRuntime(overrides: HookOverrides = {}): { runtime: DockerComposeIsolation; calls: HookCalls } {
  const calls = freshCalls();
  const runtime = new DockerComposeIsolation(fakeApp, {
    resolveArkSourceRoot: () => (overrides.arkSourceNull ? null : "/opt/ark-source"),
    allocatePort: async () => {
      const port = overrides.portSeed ?? 45000;
      calls.allocated.push(port);
      return port;
    },
    pullImage: async (image) => {
      calls.pull.push(image);
    },
    createContainer: async (name, image, opts) => {
      calls.create.push({ name, image, opts });
    },
    startContainer: async (name) => {
      calls.start.push(name);
    },
    stopContainer: async (name) => {
      calls.stop.push(name);
    },
    removeContainer: async (name) => {
      calls.remove.push(name);
    },
    bootstrapContainer: async (name, opts) => {
      if (overrides.bootstrapThrows) throw overrides.bootstrapThrows;
      calls.bootstrap.push({ name, opts });
    },
    startArkdInContainer: async (name, url) => {
      calls.startArkd.push({ name, url });
    },
    waitForArkdHealth: async (url, timeout) => {
      if (overrides.waitThrows) throw overrides.waitThrows;
      calls.waitArkd.push({ url, timeout });
    },
    composeUpWithFiles: async (workdir, files) => {
      calls.composeUp.push({ workdir, files: [...files] });
      if (overrides.composeUpOk === false) {
        return { ok: false, error: overrides.composeUpError ?? "compose up exploded" };
      }
      return { ok: true };
    },
    composeDownWithFiles: async (workdir, files) => {
      calls.composeDown.push({ workdir, files: [...files] });
      if (overrides.composeDownOk === false) {
        return { ok: false, error: "compose down exploded" };
      }
      return { ok: true };
    },
    resolveComposeNetwork: async (workdir, files) => {
      calls.resolveNet.push({ workdir, files: files ? [...files] : undefined });
      return overrides.networkName ?? "myproject_default";
    },
    connectNetwork: async (network, container) => {
      calls.connectNet.push({ network, container });
    },
  });
  return { runtime, calls };
}

function makeHandle(name = "test-compose"): ComputeHandle {
  return { kind: "local", name, meta: {} };
}

let tmpDir: string;
let composePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "compose-runtime-test-"));
  composePath = join(tmpDir, "docker-compose.yml");
  writeFileSync(composePath, "services:\n  web:\n    image: nginx\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function ctx(): PrepareCtx {
  return { workdir: tmpDir };
}

// ── Basic identity ──────────────────────────────────────────────────────────

describe("DockerComposeIsolation -- identity", () => {
  it("declares kind=compose and name=docker-compose", () => {
    const r = new DockerComposeIsolation(fakeApp);
    expect(r.kind).toBe("compose");
    expect(r.name).toBe("docker-compose");
  });
});

// ── prepare (happy path) ────────────────────────────────────────────────────

describe("DockerComposeIsolation.prepare", () => {
  it("passes the resolved compose file to composeUpWithFiles and runs the sidecar lifecycle", async () => {
    const { runtime, calls } = makeRuntime();
    const handle = makeHandle();

    await runtime.prepare(new LocalCompute(fakeApp), handle, ctx());

    // Exactly one -f file, resolved to the absolute path in workdir.
    expect(calls.composeUp).toHaveLength(1);
    expect(calls.composeUp[0].files).toEqual([composePath]);
    expect(calls.composeUp[0].workdir).toBe(tmpDir);

    // Sidecar lifecycle.
    expect(calls.pull).toEqual(["ubuntu:22.04"]);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].name).toBe("ark-test-compose-compose");
    expect(calls.start).toEqual(["ark-test-compose-compose"]);
    expect(calls.bootstrap).toHaveLength(1);
    expect(calls.startArkd[0].url).toMatch(/^http:\/\/host\.docker\.internal:/);
    expect(calls.waitArkd[0].url).toBe("http://localhost:45000");

    // Network discovery + join.
    expect(calls.resolveNet[0].workdir).toBe(tmpDir);
    expect(calls.connectNet[0]).toEqual({
      network: "myproject_default",
      container: "ark-test-compose-compose",
    });

    // Handle meta populated.
    const meta = handle.meta.dockerCompose as DockerComposeMeta;
    expect(meta.composeFiles).toEqual([composePath]);
    expect(meta.arkdHostPort).toBe(45000);
    expect(meta.composeNetwork).toBe("myproject_default");
    expect(meta.containerName).toBe("ark-test-compose-compose");
    expect(meta.workdir).toBe(tmpDir);
  });
});

// ── shutdown ────────────────────────────────────────────────────────────────

describe("DockerComposeIsolation.shutdown", () => {
  it("stops + removes the sidecar and runs compose down", async () => {
    const { runtime, calls } = makeRuntime();
    const handle = makeHandle("shutdown-test");
    await runtime.prepare(new LocalCompute(fakeApp), handle, ctx());

    const meta = handle.meta.dockerCompose as DockerComposeMeta;

    await runtime.shutdown(new LocalCompute(fakeApp), handle);

    expect(calls.stop).toEqual([meta.containerName]);
    expect(calls.remove).toEqual([meta.containerName]);
    expect(calls.composeDown).toHaveLength(1);
    expect(calls.composeDown[0].files).toEqual(meta.composeFiles);
    expect(calls.composeDown[0].workdir).toBe(meta.workdir);
  });

  it("no-ops when there is no dockerCompose meta (nothing was prepared)", async () => {
    const { runtime, calls } = makeRuntime();
    await runtime.shutdown(new LocalCompute(fakeApp), makeHandle("never-prepared"));
    expect(calls.stop).toHaveLength(0);
    expect(calls.composeDown).toHaveLength(0);
  });

  it("tolerates a failing compose down", async () => {
    const { runtime, calls } = makeRuntime({ composeDownOk: false });
    const handle = makeHandle("tolerant");
    await runtime.prepare(new LocalCompute(fakeApp), handle, ctx());

    // composeDown returns {ok:false}; shutdown must not throw.
    await runtime.shutdown(new LocalCompute(fakeApp), handle);

    expect(calls.composeDown).toHaveLength(1);
  });
});

// ── rollback on sidecar failure ─────────────────────────────────────────────

describe("DockerComposeIsolation.prepare -- rollback", () => {
  it("rolls the compose stack back when bootstrap fails", async () => {
    const err = new Error("bootstrap exploded");
    const { runtime, calls } = makeRuntime({ bootstrapThrows: err });
    const handle = makeHandle("rollback");

    (await expect(runtime.prepare(new LocalCompute(fakeApp), handle, ctx()))).rejects.toThrow("bootstrap exploded");

    // Sidecar removal attempted.
    expect(calls.remove).toEqual(["ark-rollback-compose"]);
    // Compose stack was brought down.
    expect(calls.composeDown).toHaveLength(1);
    expect(calls.composeDown[0].files).toEqual(calls.composeUp[0].files);

    // Meta was NOT populated on failure.
    expect(handle.meta.dockerCompose).toBeUndefined();
  });

  it("rolls back when compose up itself fails (no sidecar touched)", async () => {
    const { runtime, calls } = makeRuntime({ composeUpOk: false, composeUpError: "boom" });

    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle("compose-fail"), ctx()))).rejects.toThrow(
      /docker compose up failed.*boom/,
    );

    // No sidecar lifecycle should have started.
    expect(calls.pull).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
  });
});

// ── config errors ───────────────────────────────────────────────────────────

describe("DockerComposeIsolation.prepare -- config errors", () => {
  it("throws a clear error when no docker-compose.yml exists in workdir", async () => {
    rmSync(composePath);
    const { runtime, calls } = makeRuntime();
    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle(), ctx()))).rejects.toThrow(
      /no docker-compose\.yml found/,
    );
    // Compose up must NOT have been invoked.
    expect(calls.composeUp).toHaveLength(0);
  });

  it("throws when ark source cannot be located", async () => {
    const { runtime } = makeRuntime({ arkSourceNull: true });
    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle(), ctx()))).rejects.toThrow(/ark source tree/);
  });
});
