/**
 * DevcontainerIsolation unit tests.
 *
 * Every docker / arkd interaction is stubbed so we never touch the daemon.
 * We assert on the sequence of operations (image build -> create -> bootstrap
 * -> postCreate -> arkd start) and on the `handle.meta.devcontainer` shape
 * that downstream code -- including `shutdown` -- keys off.
 *
 * Compose-branch tests also verify that the forwarder sidecar is created
 * (so arkd is reachable on host loopback across macOS + Linux) and that
 * shutdown tears it down in the right order.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { DevcontainerIsolation, type DevcontainerIsolationMeta } from "../isolation/devcontainer.js";
import { LocalCompute } from "../core/local.js";
import type { ComputeHandle, LaunchOpts, PrepareCtx } from "../core/types.js";
import type { ArkdClient } from "../../arkd/client.js";
import type { DevcontainerShape } from "../providers/docker/devcontainer-resolve.js";
import type { AppContext } from "../../core/app.js";

const fakeApp = {
  config: { dirs: { ark: "/tmp/ark" }, ports: { arkd: 19300, conductor: 19100 } },
} as unknown as AppContext;

// ── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dirname, "fixtures", "devcontainer");
const IMAGE_ONLY = join(FIXTURES, "image-only");
const COMPOSE = join(FIXTURES, "compose");

function mkTmpWorkdir(): string {
  return mkdtempSync(join(tmpdir(), "devcontainer-runtime-test-"));
}

/** Write a full `.devcontainer/devcontainer.json` for a dynamic fixture. */
function writeDevcontainerJson(workdir: string, contents: Record<string, unknown>): void {
  mkdirSync(join(workdir, ".devcontainer"), { recursive: true });
  writeFileSync(join(workdir, ".devcontainer", "devcontainer.json"), JSON.stringify(contents));
}

// ── Stubs / recorders ───────────────────────────────────────────────────────

type Op = { op: string; args: unknown[] };

function makeRecorder() {
  const log: Op[] = [];
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      log.push({ op, args });
    };
  return { log, record };
}

function stubArkdClient(): ArkdClient {
  const client = {
    launchAgent: async (_req: unknown) => ({ ok: true }),
  } as unknown as ArkdClient;
  return client;
}

function makeHandle(name = "dc-test"): ComputeHandle {
  return { kind: "local", name, meta: {} };
}

function prepareCtx(workdir: string): PrepareCtx {
  return { workdir };
}

function launchOpts(workdir: string): LaunchOpts {
  return {
    tmuxName: "ark-s-test",
    workdir,
    launcherContent: "#!/bin/bash\necho hi",
  };
}

// ── Builder that wires a runtime with a fresh recorder + controllable deps ──

interface HarnessOpts {
  /** Overridden docker exec (covers compose up, compose ps, docker inspect, etc.). */
  execFile?: (
    cmd: string,
    args: string[],
    opts?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Flip to simulate postCreateCommand failure. */
  failPostCreate?: boolean;
  /** Flip to simulate arkd-never-comes-up in compose branch. */
  failHealth?: boolean;
  /** Override buildImage's return value (default: "built:latest"). */
  imageTag?: string;
  /** If true, buildImage throws -- used to check error surfacing. */
  failBuildImage?: boolean;
  /** Override composeFile service ps resolution. */
  composeServiceContainerId?: string;
  /** Compose network inspect answer. */
  composeNetwork?: string;
  /** Port allocator return value (default: 45678). */
  hostPort?: number;
}

function buildHarness(opts: HarnessOpts = {}) {
  const { log, record } = makeRecorder();

  const buildImage = async (workdir: string, shape: DevcontainerShape) => {
    log.push({ op: "buildImage", args: [workdir, shape] });
    if (opts.failBuildImage) throw new Error("build failed");
    const tag = opts.imageTag ?? "built:latest";
    shape.image = shape.image ?? tag;
    return shape.image ?? tag;
  };

  const allocatePort = async () => {
    const p = opts.hostPort ?? 45678;
    log.push({ op: "allocatePort", args: [p] });
    return p;
  };

  const createContainer = (async (name: string, image: string, createOpts?: Record<string, unknown>) => {
    log.push({ op: "createContainer", args: [name, image, createOpts] });
  }) as never;

  const startContainer = (async (name: string) => {
    log.push({ op: "startContainer", args: [name] });
  }) as never;

  const stopContainer = (async (name: string) => {
    log.push({ op: "stopContainer", args: [name] });
  }) as never;

  const removeContainer = (async (name: string) => {
    log.push({ op: "removeContainer", args: [name] });
  }) as never;

  const bootstrapContainer = (async (name: string, bootOpts?: unknown) => {
    log.push({ op: "bootstrapContainer", args: [name, bootOpts] });
  }) as never;

  const startArkdInContainer = (async (name: string, url: string) => {
    log.push({ op: "startArkdInContainer", args: [name, url] });
  }) as never;

  const waitForArkdHealth = (async (url: string) => {
    log.push({ op: "waitForArkdHealth", args: [url] });
    if (opts.failHealth) throw new Error("arkd never healthy");
  }) as never;

  const resolveArkSourceRoot = (() => {
    log.push({ op: "resolveArkSourceRoot", args: [] });
    return "/opt/ark-source";
  }) as never;

  const defaultExec = async (cmd: string, args: string[], execOpts?: Record<string, unknown>) => {
    log.push({ op: "exec", args: [cmd, args, execOpts] });
    // docker exec ... <postCreateCommand> -- simulate failure when asked.
    if (
      opts.failPostCreate &&
      cmd === "docker" &&
      args[0] === "exec" &&
      args.includes("bash") &&
      args.includes("-lc")
    ) {
      throw new Error("postCreate failed");
    }
    // docker compose -f <file> ps -q <service>
    if (cmd === "docker" && args[0] === "compose" && args.includes("ps") && args.includes("-q")) {
      return { stdout: (opts.composeServiceContainerId ?? "cid-abc123") + "\n", stderr: "" };
    }
    // docker inspect --format '…{{$k}}…' <cid>
    if (
      cmd === "docker" &&
      args[0] === "inspect" &&
      args.some((a) => typeof a === "string" && a.includes("Networks"))
    ) {
      return { stdout: (opts.composeNetwork ?? "compose_default") + "\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };

  const runtime = new DevcontainerIsolation(fakeApp, {
    buildImage,
    allocatePort,
    createContainer,
    startContainer,
    stopContainer,
    removeContainer,
    bootstrapContainer,
    startArkdInContainer,
    waitForArkdHealth,
    resolveArkSourceRoot,
    execFile: opts.execFile ?? defaultExec,
    arkdClientFactory: () => stubArkdClient(),
  });

  return { runtime, log, record };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("DevcontainerIsolation", async () => {
  let tmpCleanup: string[] = [];

  beforeEach(() => {
    for (const p of tmpCleanup) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tmpCleanup = [];
  });

  it("has kind=devcontainer and matching name", () => {
    const r = new DevcontainerIsolation(fakeApp);
    expect(r.kind).toBe("devcontainer");
    expect(r.name).toBe("devcontainer");
  });

  // ── Image-only branch ────────────────────────────────────────────────────

  describe("image branch", async () => {
    it("builds image, creates + bootstraps + starts arkd, records meta", async () => {
      const { runtime, log } = buildHarness();
      const h = makeHandle("unit-image");

      await runtime.prepare(new LocalCompute(fakeApp), h, prepareCtx(IMAGE_ONLY));

      const methods = log.map((e) => e.op);
      // We expect the following happy-path order for an image-only devcontainer.
      // allocatePort may run before or after createContainer's ordering is
      // unimportant -- but buildImage MUST precede createContainer, and
      // createContainer MUST precede bootstrap, which precedes arkd start.
      const idx = (name: string) => methods.indexOf(name);
      expect(idx("buildImage")).toBeGreaterThanOrEqual(0);
      expect(idx("createContainer")).toBeGreaterThan(idx("buildImage"));
      expect(idx("startContainer")).toBeGreaterThan(idx("createContainer"));
      expect(idx("bootstrapContainer")).toBeGreaterThan(idx("startContainer"));
      expect(idx("startArkdInContainer")).toBeGreaterThan(idx("bootstrapContainer"));
      expect(idx("waitForArkdHealth")).toBeGreaterThan(idx("startArkdInContainer"));

      const meta = (h.meta as Record<string, unknown>).devcontainer as DevcontainerIsolationMeta;
      expect(meta).toBeTruthy();
      expect(meta.mode).toBe("image");
      expect(meta.forwarderName).toBeNull();
      expect(meta.composeFile).toBeNull();
      expect(meta.composeService).toBeNull();
      expect(meta.containerName.startsWith("ark-dc-")).toBe(true);
      expect(meta.arkdHostPort).toBe(45678);
      expect(meta.arkdUrl).toBe("http://127.0.0.1:45678");
      expect(meta.devcontainerShape.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
      expect(meta.workdir).toBe(IMAGE_ONLY);
    });

    it("runs postCreateCommand between bootstrap and arkd start", async () => {
      const workdir = mkTmpWorkdir();
      tmpCleanup.push(workdir);
      writeDevcontainerJson(workdir, {
        image: "ubuntu:22.04",
        postCreateCommand: "echo hello",
      });

      const { runtime, log } = buildHarness();
      await runtime.prepare(new LocalCompute(fakeApp), makeHandle("pc"), prepareCtx(workdir));

      const methods = log.map((e) => e.op);
      // Find the `exec` entry that runs the postCreate command -- it's the
      // first exec call in the image branch.
      const execIdx = methods.indexOf("exec");
      expect(execIdx).toBeGreaterThanOrEqual(0);
      expect(execIdx).toBeGreaterThan(methods.indexOf("bootstrapContainer"));
      expect(execIdx).toBeLessThan(methods.indexOf("startArkdInContainer"));

      const execArgs = log[execIdx].args[1] as string[];
      // docker exec -i <container> bash -lc "echo hello"
      expect(execArgs[0]).toBe("exec");
      expect(execArgs[1]).toBe("-i");
      expect(execArgs.slice(-3)).toEqual(["bash", "-lc", "echo hello"]);
    });

    it("postCreateCommand failure aborts prepare and removes the container", async () => {
      const workdir = mkTmpWorkdir();
      tmpCleanup.push(workdir);
      writeDevcontainerJson(workdir, {
        image: "ubuntu:22.04",
        postCreateCommand: "exit 1",
      });

      const { runtime, log } = buildHarness({ failPostCreate: true });
      const h = makeHandle("fail-pc");
      (await expect(runtime.prepare(new LocalCompute(fakeApp), h, prepareCtx(workdir)))).rejects.toThrow(
        "postCreate failed",
      );

      const methods = log.map((e) => e.op);
      // We created a container and must have torn it down on error.
      expect(methods).toContain("createContainer");
      expect(methods).toContain("removeContainer");
      // Arkd was never started.
      expect(methods).not.toContain("startArkdInContainer");
      expect(methods).not.toContain("waitForArkdHealth");
      // No meta was recorded because prepare threw.
      expect((h.meta as Record<string, unknown>).devcontainer).toBeUndefined();
    });

    it("warns (via onLog) but continues when features are declared", async () => {
      const workdir = mkTmpWorkdir();
      tmpCleanup.push(workdir);
      writeDevcontainerJson(workdir, {
        image: "ubuntu:22.04",
        features: { "ghcr.io/devcontainers/features/node:1": {} },
      });

      const logs: string[] = [];
      const { runtime } = buildHarness();
      await runtime.prepare(new LocalCompute(fakeApp), makeHandle("feat"), { workdir, onLog: (m) => logs.push(m) });

      expect(logs.some((l) => l.includes("features not yet supported"))).toBe(true);
    });
  });

  // ── Compose branch ───────────────────────────────────────────────────────

  describe("compose branch", async () => {
    it("compose up -> find container -> bootstrap -> arkd start -> forwarder", async () => {
      const { runtime, log } = buildHarness({ composeServiceContainerId: "cid-compose-1" });
      const h = makeHandle("compose-1");

      await runtime.prepare(new LocalCompute(fakeApp), h, prepareCtx(COMPOSE));

      // Inspect the exec log to verify the compose up + ps + forwarder sidecar
      // commands were issued in the right order.
      const execCalls = log.filter((e) => e.op === "exec").map((e) => e.args[1] as string[]);
      const composeUp = execCalls.findIndex((a) => a[0] === "compose" && a.includes("up"));
      const composePs = execCalls.findIndex((a) => a[0] === "compose" && a.includes("ps"));
      const inspect = execCalls.findIndex((a) => a[0] === "inspect");
      const socatRun = execCalls.findIndex((a) => a[0] === "run" && a.includes("alpine/socat"));

      expect(composeUp).toBeGreaterThanOrEqual(0);
      expect(composePs).toBeGreaterThan(composeUp);
      expect(inspect).toBeGreaterThan(composePs);
      expect(socatRun).toBeGreaterThan(inspect);

      // Verify the runtime bootstrapped against the compose-resolved container
      // id, not some constant name it made up.
      const bootstrapCall = log.find((e) => e.op === "bootstrapContainer");
      expect(bootstrapCall?.args[0]).toBe("cid-compose-1");
      const startArkdCall = log.find((e) => e.op === "startArkdInContainer");
      expect(startArkdCall?.args[0]).toBe("cid-compose-1");

      // Forwarder sidecar command: docker run -d --rm --name ark-fwd-* --network …
      const socatArgs = execCalls[socatRun];
      expect(socatArgs[0]).toBe("run");
      expect(socatArgs).toContain("-d");
      expect(socatArgs).toContain("--rm");
      const nameIdx = socatArgs.indexOf("--name");
      expect(nameIdx).toBeGreaterThanOrEqual(0);
      expect(socatArgs[nameIdx + 1].startsWith("ark-fwd-")).toBe(true);
      const netIdx = socatArgs.indexOf("--network");
      expect(socatArgs[netIdx + 1]).toBe("compose_default");
      expect(socatArgs.some((a) => a.includes("127.0.0.1:45678:19300"))).toBe(true);

      const meta = (h.meta as Record<string, unknown>).devcontainer as DevcontainerIsolationMeta;
      expect(meta.mode).toBe("compose");
      expect(meta.containerName).toBe("cid-compose-1");
      expect(meta.composeService).toBe("devcontainer");
      expect(meta.forwarderName?.startsWith("ark-fwd-")).toBe(true);
      expect(meta.composeFile?.endsWith("docker-compose.yml")).toBe(true);
      expect(meta.arkdUrl).toBe("http://127.0.0.1:45678");
    });

    it("throws when compose ps returns no container for the service", async () => {
      const { runtime } = buildHarness({ composeServiceContainerId: "" });
      const h = makeHandle("compose-empty");
      (await expect(runtime.prepare(new LocalCompute(fakeApp), h, prepareCtx(COMPOSE)))).rejects.toThrow(
        /no container for service/,
      );
    });
  });

  // ── shutdown ────────────────────────────────────────────────────────────

  describe("shutdown", async () => {
    it("image mode: stops + removes the container, no compose calls", async () => {
      const { runtime, log } = buildHarness();
      const h = makeHandle("shutdown-image");
      await runtime.prepare(new LocalCompute(fakeApp), h, prepareCtx(IMAGE_ONLY));
      log.length = 0;

      await runtime.shutdown(new LocalCompute(fakeApp), h);
      const methods = log.map((e) => e.op);
      expect(methods).toContain("stopContainer");
      expect(methods).toContain("removeContainer");
      // No compose down in image mode.
      const composeDowns = log.filter(
        (e) => e.op === "exec" && (e.args[1] as string[])[0] === "compose" && (e.args[1] as string[]).includes("down"),
      );
      expect(composeDowns.length).toBe(0);
    });

    it("compose mode: removes forwarder first, then compose down", async () => {
      const { runtime, log } = buildHarness({ composeServiceContainerId: "cid-shut-1" });
      const h = makeHandle("shutdown-compose");
      await runtime.prepare(new LocalCompute(fakeApp), h, prepareCtx(COMPOSE));
      log.length = 0;

      await runtime.shutdown(new LocalCompute(fakeApp), h);

      // Forwarder removal vs compose down ordering: removeContainer for the
      // forwarder must come before the `docker compose ... down` exec call.
      const rmIdx = log.findIndex((e) => e.op === "removeContainer");
      const downIdx = log.findIndex(
        (e) => e.op === "exec" && (e.args[1] as string[])[0] === "compose" && (e.args[1] as string[]).includes("down"),
      );
      expect(rmIdx).toBeGreaterThanOrEqual(0);
      expect(downIdx).toBeGreaterThan(rmIdx);

      const forwarderArg = log[rmIdx].args[0] as string;
      expect(forwarderArg.startsWith("ark-fwd-")).toBe(true);
    });

    it("is a safe no-op when called on a handle without devcontainer meta", async () => {
      const { runtime } = buildHarness();
      const h = makeHandle("no-meta");
      // Must not throw.
      await runtime.shutdown(new LocalCompute(fakeApp), h);
    });
  });

  // ── Missing devcontainer.json ───────────────────────────────────────────

  describe("missing devcontainer.json", async () => {
    it("prepare throws a targeted error pointing at the expected paths", async () => {
      const workdir = mkTmpWorkdir();
      tmpCleanup.push(workdir);
      const { runtime } = buildHarness();
      (
        await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle("none"), prepareCtx(workdir)))
      ).rejects.toThrow(/no devcontainer\.json found/);
    });
  });

  // ── launchAgent ─────────────────────────────────────────────────────────

  describe("launchAgent", async () => {
    it("forwards to arkd client built against the stored arkd URL", async () => {
      const calls: { url: string; req: unknown }[] = [];
      const harness = buildHarness();
      harness.runtime.setDeps({
        arkdClientFactory: (url: string) =>
          ({
            launchAgent: async (req: unknown) => {
              calls.push({ url, req });
              return { ok: true } as never;
            },
          }) as unknown as ArkdClient,
      });

      const h = makeHandle("launch-a");
      await harness.runtime.prepare(new LocalCompute(fakeApp), h, prepareCtx(IMAGE_ONLY));
      const out = await harness.runtime.launchAgent(new LocalCompute(fakeApp), h, launchOpts("/tmp/work"));

      expect(out.sessionName).toBe("ark-s-test");
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe("http://127.0.0.1:45678");
      expect(calls[0].req).toEqual({
        sessionName: "ark-s-test",
        script: "#!/bin/bash\necho hi",
        workdir: "/tmp/work",
      });
    });
  });
});
