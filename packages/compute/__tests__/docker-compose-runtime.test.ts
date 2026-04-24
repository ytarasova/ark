/**
 * DockerComposeRuntime unit tests.
 *
 * All Docker interactions are stubbed via the runtime's `hooks` surface so
 * the tests can run without a real Docker daemon. We assert:
 *   - File-only, inline-only, and file+inline prepare flows.
 *   - Inline tempfile is written with the correct YAML and cleaned up on shutdown.
 *   - Two `-f` flags when both file + inline are present.
 *   - shutdown tolerates a failing `docker compose down`.
 *   - A sidecar-bootstrap failure rolls back the compose stack + inline tempfile.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";

import { DockerComposeRuntime, type DockerComposeMeta } from "../runtimes/docker-compose.js";
import { LocalCompute } from "../core/local.js";
import type { ComputeHandle, PrepareCtx } from "../core/types.js";
import type { AppContext } from "../../core/app.js";

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
  writeInline: Array<{ spec: Record<string, unknown>; path: string }>;
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
    writeInline: [],
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
  writeInlineThrows?: Error;
}

/**
 * Build a runtime preloaded with stubbed hooks. Returns both the runtime and
 * the call recorder so tests can assert on exact arguments.
 */
function makeRuntime(overrides: HookOverrides = {}): { runtime: DockerComposeRuntime; calls: HookCalls } {
  const calls = freshCalls();
  const runtime = new DockerComposeRuntime(fakeApp, {
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
    writeInlineCompose: async (spec, path) => {
      if (overrides.writeInlineThrows) throw overrides.writeInlineThrows;
      calls.writeInline.push({ spec, path });
      // Ensure parent dir exists; in production this is mkdir'd by the real
      // implementation (`runtime/<name>/`). Tests point `ARK_DIR` at a tmp
      // location but we mkdir here defensively anyway.
      mkdirSync(dirname(path), { recursive: true });
      // Actually write the file so other tests can inspect it.
      writeFileSync(path, "# stub\n", "utf-8");
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
let arkDir: string;
let composePath: string;
let prevArkDir: string | undefined;
let prevHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "compose-runtime-test-"));
  arkDir = mkdtempSync(join(tmpdir(), "compose-runtime-ark-"));
  composePath = join(tmpDir, "docker-compose.yml");
  writeFileSync(composePath, "services:\n  web:\n    image: nginx\n");

  // The runtime's private `runtimeDir` falls back to `$HOME/.ark/runtime/<name>`
  // when no AppContext is injected. Point HOME at our tmp arkDir to keep
  // every inline tempfile inside the test sandbox.
  prevHome = process.env.HOME;
  prevArkDir = process.env.ARK_DIR;
  process.env.HOME = arkDir;
  delete process.env.ARK_DIR;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevArkDir === undefined) delete process.env.ARK_DIR;
  else process.env.ARK_DIR = prevArkDir;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(arkDir, { recursive: true, force: true });
});

function writeArc(body: unknown): void {
  writeFileSync(join(tmpDir, "arc.json"), JSON.stringify(body));
}

function ctx(): PrepareCtx {
  return { workdir: tmpDir };
}

// ── Basic identity ──────────────────────────────────────────────────────────

describe("DockerComposeRuntime -- identity", () => {
  it("declares kind=compose and name=docker-compose", () => {
    const r = new DockerComposeRuntime(fakeApp);
    expect(r.kind).toBe("compose");
    expect(r.name).toBe("docker-compose");
  });
});

// ── prepare (happy paths) ───────────────────────────────────────────────────

describe("DockerComposeRuntime.prepare -- file only", async () => {
  it("passes the resolved compose file to composeUpWithFiles and does not write an inline tempfile", async () => {
    writeArc({ compose: true });
    const { runtime, calls } = makeRuntime();
    const handle = makeHandle();

    await runtime.prepare(new LocalCompute(fakeApp), handle, ctx());

    // Exactly one -f file, resolved to the absolute path in workdir.
    expect(calls.composeUp).toHaveLength(1);
    expect(calls.composeUp[0].files).toEqual([composePath]);
    expect(calls.writeInline).toHaveLength(0);

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
    expect(meta.inlineTempPath).toBeNull();
    expect(meta.arkdHostPort).toBe(45000);
    expect(meta.composeNetwork).toBe("myproject_default");
    expect(meta.containerName).toBe("ark-test-compose-compose");
  });

  it("accepts an explicit file path via compose.file", async () => {
    const altPath = join(tmpDir, "docker-compose.prod.yml");
    writeFileSync(altPath, "services: {}\n");
    writeArc({ compose: { file: "docker-compose.prod.yml" } });

    const { runtime, calls } = makeRuntime();
    await runtime.prepare(new LocalCompute(fakeApp), makeHandle(), ctx());
    expect(calls.composeUp[0].files).toEqual([altPath]);
  });

  it("throws when the configured file is missing", async () => {
    writeArc({ compose: { file: "does-not-exist.yml" } });
    const { runtime, calls } = makeRuntime();
    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle(), ctx()))).rejects.toThrow(
      /compose file not found/,
    );
    // Compose up must NOT have been invoked.
    expect(calls.composeUp).toHaveLength(0);
  });
});

// ── prepare (inline only) ───────────────────────────────────────────────────

describe("DockerComposeRuntime.prepare -- inline only", async () => {
  it("writes the inline spec as YAML and passes it as a single -f", async () => {
    // Remove the default docker-compose.yml so only inline is used.
    rmSync(composePath);
    const inline = {
      services: {
        redis: { image: "redis:7", ports: ["6379:6379"] },
      },
    };
    writeArc({ compose: { inline } });

    // Bypass the stubbed writeInlineCompose so we exercise the real YAML
    // serializer. That way we actually verify correct output.
    const { runtime, calls } = makeRuntime();
    runtime.setHooks({ writeInlineCompose: undefined as unknown as never });
    // The above disables the stub; we route through the real module.
    // But the stub we originally passed also wrote a fake `# stub` line to
    // the path -- reset by re-instantiating without the hook.
    const runtime2 = new DockerComposeRuntime(fakeApp, {
      resolveArkSourceRoot: () => "/opt/ark-source",
      allocatePort: async () => 45100,
      pullImage: async (image) => {
        calls.pull.push(image);
      },
      createContainer: async (name, image, opts) => {
        calls.create.push({ name, image, opts });
      },
      startContainer: async (name) => {
        calls.start.push(name);
      },
      bootstrapContainer: async (name, opts) => {
        calls.bootstrap.push({ name, opts });
      },
      startArkdInContainer: async (name, url) => {
        calls.startArkd.push({ name, url });
      },
      waitForArkdHealth: async (url, timeout) => {
        calls.waitArkd.push({ url, timeout });
      },
      composeUpWithFiles: async (workdir, files) => {
        calls.composeUp.push({ workdir, files: [...files] });
        return { ok: true };
      },
      composeDownWithFiles: async () => ({ ok: true }),
      resolveComposeNetwork: async () => "myproject_default",
      connectNetwork: async () => {},
      // writeInlineCompose NOT overridden -- real impl runs.
    });

    const handle = makeHandle("inline-only");
    await runtime2.prepare(new LocalCompute(fakeApp), handle, ctx());

    expect(calls.composeUp).toHaveLength(1);
    expect(calls.composeUp[0].files).toHaveLength(1);
    const inlinePath = calls.composeUp[0].files[0];
    expect(inlinePath).toContain("compose.inline.");
    expect(inlinePath).toMatch(/\.yml$/);
    expect(existsSync(inlinePath)).toBe(true);

    const yaml = readFileSync(inlinePath, "utf-8");
    const roundTripped = parseYaml(yaml);
    expect(roundTripped).toEqual(inline);

    // Stored on meta.
    const meta = handle.meta.dockerCompose as DockerComposeMeta;
    expect(meta.inlineTempPath).toBe(inlinePath);
    expect(meta.composeFiles).toEqual([inlinePath]);

    // Clean up the written tempfile so the afterEach doesn't leave .ark dirs around.
    rmSync(inlinePath, { force: true });
  });

  it("calls writeInlineCompose hook when provided", async () => {
    rmSync(composePath);
    const inline = { services: { db: { image: "postgres:16" } } };
    writeArc({ compose: { inline } });

    const { runtime, calls } = makeRuntime();
    const handle = makeHandle("inline-stub");
    await runtime.prepare(new LocalCompute(fakeApp), handle, ctx());

    expect(calls.writeInline).toHaveLength(1);
    expect(calls.writeInline[0].spec).toEqual(inline);
    expect(calls.writeInline[0].path).toContain("compose.inline.");
    expect(calls.composeUp[0].files).toEqual([calls.writeInline[0].path]);
  });
});

// ── prepare (file + inline) ─────────────────────────────────────────────────

describe("DockerComposeRuntime.prepare -- file + inline", async () => {
  it("passes both files, file first, inline second", async () => {
    const inline = { services: { extra: { image: "busybox" } } };
    writeArc({ compose: { file: "docker-compose.yml", inline } });

    const { runtime, calls } = makeRuntime();
    const handle = makeHandle("both");
    await runtime.prepare(new LocalCompute(fakeApp), handle, ctx());

    expect(calls.composeUp).toHaveLength(1);
    const files = calls.composeUp[0].files;
    expect(files).toHaveLength(2);
    expect(files[0]).toBe(composePath);
    expect(files[1]).toContain("compose.inline.");

    // writeInline was invoked with the inline spec.
    expect(calls.writeInline).toHaveLength(1);
    expect(calls.writeInline[0].spec).toEqual(inline);

    // Compose network resolution receives both files.
    expect(calls.resolveNet[0].files).toEqual(files);

    // Meta reflects both.
    const meta = handle.meta.dockerCompose as DockerComposeMeta;
    expect(meta.composeFiles).toEqual(files);
    expect(meta.inlineTempPath).toBe(files[1]);
  });

  it("honors compose.skipUp and does not shell out to `docker compose up`", async () => {
    writeArc({ compose: { file: "docker-compose.yml", skipUp: true } });
    const { runtime, calls } = makeRuntime();
    await runtime.prepare(new LocalCompute(fakeApp), makeHandle("skip-up"), ctx());
    expect(calls.composeUp).toHaveLength(0);
    // But the sidecar lifecycle still runs.
    expect(calls.start).toHaveLength(1);
  });
});

// ── shutdown ────────────────────────────────────────────────────────────────

describe("DockerComposeRuntime.shutdown", async () => {
  it("removes the inline tempfile and runs compose down", async () => {
    rmSync(composePath);
    writeArc({ compose: { inline: { services: { q: { image: "rabbitmq" } } } } });
    const { runtime, calls } = makeRuntime();
    const handle = makeHandle("shutdown-test");
    await runtime.prepare(new LocalCompute(fakeApp), handle, ctx());

    const meta = handle.meta.dockerCompose as DockerComposeMeta;
    expect(existsSync(meta.inlineTempPath!)).toBe(true);

    await runtime.shutdown(new LocalCompute(fakeApp), handle);

    expect(calls.stop).toEqual([meta.containerName]);
    expect(calls.remove).toEqual([meta.containerName]);
    expect(calls.composeDown).toHaveLength(1);
    expect(calls.composeDown[0].files).toEqual(meta.composeFiles);
    expect(existsSync(meta.inlineTempPath!)).toBe(false);
  });

  it("no-ops when there is no dockerCompose meta (nothing was prepared)", async () => {
    const { runtime, calls } = makeRuntime();
    await runtime.shutdown(new LocalCompute(fakeApp), makeHandle("never-prepared"));
    expect(calls.stop).toHaveLength(0);
    expect(calls.composeDown).toHaveLength(0);
  });

  it("tolerates a failing compose down and still removes the tempfile", async () => {
    rmSync(composePath);
    writeArc({ compose: { inline: { services: {} } } });
    // Start by preparing successfully...
    const { runtime, calls } = makeRuntime({ composeDownOk: false });
    const handle = makeHandle("tolerant");
    await runtime.prepare(new LocalCompute(fakeApp), handle, ctx());

    const meta = handle.meta.dockerCompose as DockerComposeMeta;
    expect(existsSync(meta.inlineTempPath!)).toBe(true);

    // ...then shut down. composeDown returns {ok:false}; shutdown must not throw.
    await runtime.shutdown(new LocalCompute(fakeApp), handle);

    expect(calls.composeDown).toHaveLength(1);
    // Tempfile is still removed.
    expect(existsSync(meta.inlineTempPath!)).toBe(false);
  });
});

// ── rollback on sidecar failure ─────────────────────────────────────────────

describe("DockerComposeRuntime.prepare -- rollback", async () => {
  it("rolls the compose stack + inline tempfile back when bootstrap fails", async () => {
    rmSync(composePath);
    writeArc({ compose: { inline: { services: { web: { image: "nginx" } } } } });

    const err = new Error("bootstrap exploded");
    const { runtime, calls } = makeRuntime({ bootstrapThrows: err });
    const handle = makeHandle("rollback");

    (await expect(runtime.prepare(new LocalCompute(fakeApp), handle, ctx()))).rejects.toThrow("bootstrap exploded");

    // Sidecar removal attempted.
    expect(calls.remove).toEqual(["ark-rollback-compose"]);
    // Compose stack was brought down.
    expect(calls.composeDown).toHaveLength(1);
    expect(calls.composeDown[0].files).toEqual(calls.composeUp[0].files);

    // Inline tempfile was cleaned up.
    const inlinePath = calls.writeInline[0].path;
    expect(existsSync(inlinePath)).toBe(false);

    // Meta was NOT populated on failure.
    expect(handle.meta.dockerCompose).toBeUndefined();
  });

  it("rolls back when compose up itself fails (no sidecar touched)", async () => {
    rmSync(composePath);
    writeArc({ compose: { inline: { services: {} } } });
    const { runtime, calls } = makeRuntime({ composeUpOk: false, composeUpError: "boom" });

    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle("compose-fail"), ctx()))).rejects.toThrow(
      /docker compose up failed.*boom/,
    );

    // No sidecar lifecycle should have started.
    expect(calls.pull).toHaveLength(0);
    expect(calls.create).toHaveLength(0);
    // Inline tempfile was cleaned up even though up failed.
    const inlinePath = calls.writeInline[0].path;
    expect(existsSync(inlinePath)).toBe(false);
  });

  it("skips compose down during rollback when skipUp is set", async () => {
    writeArc({ compose: { file: "docker-compose.yml", skipUp: true } });
    const { runtime, calls } = makeRuntime({ waitThrows: new Error("unhealthy") });
    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle("skip-down"), ctx()))).rejects.toThrow(
      "unhealthy",
    );
    // Sidecar removed.
    expect(calls.remove).toHaveLength(1);
    // But we did not ask the user to bring a stack up, so we don't bring it down either.
    expect(calls.composeDown).toHaveLength(0);
  });
});

// ── arc.json surface errors ─────────────────────────────────────────────────

describe("DockerComposeRuntime.prepare -- config errors", async () => {
  it("throws a clear error when arc.json has no compose block", async () => {
    writeArc({ ports: [{ port: 3000 }] });
    const { runtime } = makeRuntime();
    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle(), ctx()))).rejects.toThrow(
      /no compose config/,
    );
  });

  it("throws when arc.json is missing entirely", async () => {
    const { runtime } = makeRuntime();
    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle(), ctx()))).rejects.toThrow(
      /no compose config/,
    );
  });

  it("throws when ark source cannot be located", async () => {
    writeArc({ compose: true });
    const { runtime } = makeRuntime({ arkSourceNull: true });
    (await expect(runtime.prepare(new LocalCompute(fakeApp), makeHandle(), ctx()))).rejects.toThrow(/ark source tree/);
  });
});
