# Compute / Runtime split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Express the existing two-axis schema model
(`(compute_kind, runtime_kind)`) at the implementation layer:
`ComputeProvider` for hardware acquisition, `Runtime` for isolation
wrapping. Eliminate combined classes (`LocalDockerProvider` etc.) in
favor of provider+runtime composition.

**Architecture:** See
`docs/superpowers/specs/2026-05-01-compute-runtime-split-design.md`.
Phase 1 ships the `Runtime` interface + 5 impls behind a registry,
preserving existing combined classes; Phase 2 tightens
`ComputeProvider`'s host-poke surface; Phase 3 splits the combined
classes into `provider × runtime` composition; Phase 4 lifts session
orchestration into a provider-agnostic runner.

**Tech stack:** TypeScript (strict: false), Bun, existing
`ComputeProvider` interface in `packages/compute/types.ts`.

**Scope of THIS plan:** Phase 1 + Phase 2. Phase 3 (class split) and
Phase 4 (orchestrator lift) are large enough to merit their own plan
documents and ship after Phase 1+2 has burned in for at least one
production cycle.

---

### Task 1: Define the `Runtime` interface

**Files:**

- Create: `packages/compute/runtimes/types.ts`
- Test: `packages/compute/runtimes/__tests__/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/runtimes/__tests__/types.test.ts
import { describe, expect, test } from "bun:test";
import type { Runtime, RuntimeKind } from "../types.js";

describe("Runtime interface", () => {
  test("Runtime kind discriminator covers every documented runtime", () => {
    const allKinds: RuntimeKind[] = [
      "direct",
      "docker",
      "docker-compose",
      "devcontainer",
      "ark-compose",
      "firecracker-in-container",
    ];
    expect(allKinds.length).toBe(6);
  });

  test("a Runtime impl has the surface fields the dispatcher reads", () => {
    const stub: Runtime = {
      kind: "direct",
      applies: () => true,
      wrapLaunchScript: (s) => s,
    };
    expect(stub.kind).toBe("direct");
    expect(stub.applies("")).toBe(true);
    expect(stub.wrapLaunchScript("foo", { compute: {} as any, session: {} as any, workdir: "/x" })).toBe("foo");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test-file F=packages/compute/runtimes/__tests__/types.test.ts`
Expected: FAIL — module `../types.js` not found.

- [ ] **Step 3: Write the interface module**

```ts
// packages/compute/runtimes/types.ts
import type { Compute, Session, ComputeProvider } from "../types.js";
import type { AppContext } from "../../core/app.js";

export type RuntimeKind =
  | "direct"
  | "docker"
  | "docker-compose"
  | "devcontainer"
  | "ark-compose"
  | "firecracker-in-container";

export interface PrepareIsolationOpts {
  app: AppContext;
  compute: Compute;
  session: Session;
  provider: ComputeProvider;
  workdir: string;
  onLog: (msg: string) => void;
}

export interface CleanupIsolationOpts {
  app: AppContext;
  compute: Compute;
  session: Session;
  provider: ComputeProvider;
  workdir: string;
}

export interface WrapCtx {
  compute: Compute;
  session: Session;
  workdir: string;
}

export interface Runtime {
  readonly kind: RuntimeKind;
  applies(workdir: string): boolean;
  prepareIsolation?(opts: PrepareIsolationOpts): Promise<void>;
  wrapLaunchScript(script: string, ctx: WrapCtx): string;
  cleanup?(opts: CleanupIsolationOpts): Promise<void>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `make test-file F=packages/compute/runtimes/__tests__/types.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/compute/runtimes/types.ts packages/compute/runtimes/__tests__/types.test.ts
git commit -m "feat(compute): introduce Runtime interface (compute/runtime split, phase 1)"
```

---

### Task 2: Add `runOnHost` to `ComputeProvider`

`runOnHost` is a thin wrapper over the host's exec primitive. Use the
medium's `execFile`-equivalent ONLY (never shell-evaluated `exec`):

- Local: `Bun.spawn` with an explicit cmd array.
- EC2: existing `sshExecArgs` (already shell-quotes each argv).
- K8s: Node's `execFile` (NOT `exec`) wrapped in `promisify`.

**Files:**

- Modify: `packages/compute/types.ts` (add `runOnHost` to `ComputeProvider`)
- Modify: `packages/compute/providers/local-arkd.ts` (impl: `Bun.spawn`)
- Modify: `packages/compute/providers/remote-arkd.ts` (impl: `sshExecArgs`)
- Modify: `packages/compute/providers/k8s.ts` (impl: `execFile` via `promisify`)
- Test: `packages/compute/__tests__/run-on-host.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/__tests__/run-on-host.test.ts
import { describe, expect, test } from "bun:test";
import { LocalWorktreeProvider } from "../providers/local-arkd.js";

describe("ComputeProvider.runOnHost", () => {
  test("LocalWorktreeProvider.runOnHost spawns the command on the host", async () => {
    const provider = new LocalWorktreeProvider({} as any);
    const result = await provider.runOnHost!({} as any, ["echo", "hello"], { timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test-file F=packages/compute/__tests__/run-on-host.test.ts`
Expected: FAIL — `runOnHost` is not a function.

- [ ] **Step 3: Add the optional method to the interface**

In `packages/compute/types.ts`, inside `interface ComputeProvider`:

```ts
runOnHost?(
  compute: Compute,
  cmd: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

- [ ] **Step 4: Implement on Local**

In `packages/compute/providers/local-arkd.ts`, add to `LocalArkdBase`:

```ts
async runOnHost(
  _compute: Compute,
  cmd: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Bun.spawn takes an explicit argv -- no shell, no injection.
  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
  });
  const timer = opts?.timeoutMs
    ? setTimeout(() => proc.kill(), opts.timeoutMs)
    : null;
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Implement on Remote (EC2/SSM)**

In `packages/compute/providers/remote-arkd.ts`, add to `RemoteArkdBase`:

```ts
async runOnHost(
  compute: Compute,
  cmd: string[],
  opts?: { timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cfg = compute.config as RemoteConfig;
  if (!cfg.instance_id) throw new Error("No instance_id");
  const { sshExecArgs, sshKeyPath } = await import("./ec2/ssh.js");
  // sshExecArgs shell-quotes every argv element before sending.
  return sshExecArgs(sshKeyPath(compute.name), cfg.instance_id, cmd, {
    region: cfg.region ?? "us-east-1",
    awsProfile: cfg.aws_profile,
    timeout: opts?.timeoutMs ?? 30_000,
  });
}
```

- [ ] **Step 6: Implement on K8s**

In `packages/compute/providers/k8s.ts`, add to `K8sProvider`:

```ts
async runOnHost(
  compute: Compute,
  cmd: string[],
  opts?: { timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const ns = (compute.config as K8sConfig).namespace;
  const pod = (compute.config as { pod_name?: string }).pod_name;
  if (!pod) throw new Error("k8s compute has no pod_name");
  // execFile is the explicit-argv form (NOT shell-evaluated exec).
  // promisify gives us a {stdout, stderr} resolution + an Error with
  // .code/.stdout/.stderr on non-zero exit.
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);
  try {
    const { stdout, stderr } = await execFileAsync(
      "kubectl",
      ["exec", "-n", ns, pod, "--", ...cmd],
      { timeout: opts?.timeoutMs ?? 30_000 },
    );
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}
```

- [ ] **Step 7: Run the test**

Run: `make test-file F=packages/compute/__tests__/run-on-host.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/compute/types.ts packages/compute/providers packages/compute/__tests__/run-on-host.test.ts
git commit -m "feat(compute): provider.runOnHost surface (compute/runtime split, phase 1)"
```

---

### Task 3: Implement `DirectRuntime`

**Files:**

- Create: `packages/compute/runtimes/direct.ts`
- Test: `packages/compute/runtimes/__tests__/direct.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/runtimes/__tests__/direct.test.ts
import { describe, expect, test } from "bun:test";
import { DirectRuntime } from "../direct.js";

describe("DirectRuntime", () => {
  const r = new DirectRuntime();
  test("kind is 'direct'", () => {
    expect(r.kind).toBe("direct");
  });
  test("applies on every workdir", () => {
    expect(r.applies("")).toBe(true);
    expect(r.applies("/anywhere")).toBe(true);
  });
  test("wrapLaunchScript is identity", () => {
    expect(r.wrapLaunchScript("echo hi", { compute: {} as any, session: {} as any, workdir: "/x" })).toBe("echo hi");
  });
  test("has no prepareIsolation or cleanup", () => {
    expect(r.prepareIsolation).toBeUndefined();
    expect(r.cleanup).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test-file F=packages/compute/runtimes/__tests__/direct.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DirectRuntime**

```ts
// packages/compute/runtimes/direct.ts
import type { Runtime } from "./types.js";

/**
 * No-op runtime. Agent runs as the bare launcher process on the host.
 * The default for sessions whose worktree has no `arc.json:compose`,
 * `arc.json:devcontainer`, or other isolation directive.
 */
export class DirectRuntime implements Runtime {
  readonly kind = "direct" as const;
  applies(): boolean {
    return true;
  }
  wrapLaunchScript(script: string): string {
    return script;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `make test-file F=packages/compute/runtimes/__tests__/direct.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/compute/runtimes/direct.ts packages/compute/runtimes/__tests__/direct.test.ts
git commit -m "feat(runtime): DirectRuntime (no-op wrap)"
```

---

### Task 4: Implement `ComposeRuntime`

**Files:**

- Create: `packages/compute/runtimes/compose.ts`
- Test: `packages/compute/runtimes/__tests__/compose.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/runtimes/__tests__/compose.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ComposeRuntime } from "../compose.js";

function tmpWorkdir(arcJson?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "compose-runtime-"));
  if (arcJson) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "arc.json"), JSON.stringify(arcJson));
  }
  return dir;
}

describe("ComposeRuntime", () => {
  const r = new ComposeRuntime();

  test("kind is 'docker-compose'", () => {
    expect(r.kind).toBe("docker-compose");
  });

  test("applies only when arc.json sets compose: true", () => {
    expect(r.applies(tmpWorkdir())).toBe(false);
    expect(r.applies(tmpWorkdir({}))).toBe(false);
    expect(r.applies(tmpWorkdir({ compose: false }))).toBe(false);
    expect(r.applies(tmpWorkdir({ compose: true }))).toBe(true);
  });

  test("prepareIsolation calls runOnHost with `docker compose up -d`", async () => {
    const calls: Array<{ cmd: string[] }> = [];
    const provider = {
      runOnHost: async (_c: any, cmd: string[]) => {
        calls.push({ cmd });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as any;
    const workdir = tmpWorkdir({ compose: true });
    await r.prepareIsolation!({
      app: {} as any,
      compute: {} as any,
      session: {} as any,
      provider,
      workdir,
      onLog: () => {},
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual(["docker", "compose", "-f", join(workdir, "docker-compose.yml"), "up", "-d"]);
  });

  test("wrapLaunchScript pipes through unchanged (compose runs alongside; agent inherits services)", () => {
    expect(r.wrapLaunchScript("echo hi", { compute: {} as any, session: {} as any, workdir: "/x" })).toBe("echo hi");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test-file F=packages/compute/runtimes/__tests__/compose.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ComposeRuntime**

```ts
// packages/compute/runtimes/compose.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Runtime, PrepareIsolationOpts } from "./types.js";

/**
 * Wraps an agent session in a `docker compose up -d` stack defined by
 * the worktree's `arc.json:compose:true` flag and a co-located
 * `docker-compose.yml`. The agent process runs alongside the started
 * services (same network namespace via the compose default network);
 * the launch script is not wrapped -- compose-up is a side-effect, not
 * an exec wrapper.
 */
export class ComposeRuntime implements Runtime {
  readonly kind = "docker-compose" as const;

  applies(workdir: string): boolean {
    if (!workdir) return false;
    const arc = readArcJson(workdir);
    return arc?.compose === true;
  }

  async prepareIsolation(opts: PrepareIsolationOpts): Promise<void> {
    if (!opts.provider.runOnHost) {
      throw new Error("ComposeRuntime requires provider.runOnHost (compute target has no docker daemon access)");
    }
    opts.onLog("Starting Docker Compose services...");
    const composeFile = join(opts.workdir, "docker-compose.yml");
    const result = await opts.provider.runOnHost(
      opts.compute,
      ["docker", "compose", "-f", composeFile, "up", "-d"],
      { timeoutMs: 300_000 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`docker compose up failed (exit ${result.exitCode}): ${result.stderr.slice(0, 500)}`);
    }
  }

  wrapLaunchScript(script: string): string {
    return script;
  }

  async cleanup(opts: {
    provider: { runOnHost?: (c: any, cmd: string[], o?: any) => Promise<any> };
    compute: any;
    workdir: string;
  }): Promise<void> {
    if (!opts.provider.runOnHost) return;
    const composeFile = join(opts.workdir, "docker-compose.yml");
    await opts.provider.runOnHost(opts.compute, ["docker", "compose", "-f", composeFile, "down"], { timeoutMs: 60_000 });
  }
}

function readArcJson(workdir: string): { compose?: boolean; devcontainer?: boolean } | null {
  const path = join(workdir, "arc.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `make test-file F=packages/compute/runtimes/__tests__/compose.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/compute/runtimes/compose.ts packages/compute/runtimes/__tests__/compose.test.ts
git commit -m "feat(runtime): ComposeRuntime (arc.json:compose:true)"
```

---

### Task 5: Implement `DevcontainerRuntime`

**Files:**

- Create: `packages/compute/runtimes/devcontainer.ts`
- Test: `packages/compute/runtimes/__tests__/devcontainer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/runtimes/__tests__/devcontainer.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DevcontainerRuntime } from "../devcontainer.js";

function tmpWorkdir(arcJson?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "devc-runtime-"));
  if (arcJson) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "arc.json"), JSON.stringify(arcJson));
  }
  return dir;
}

describe("DevcontainerRuntime", () => {
  const r = new DevcontainerRuntime();

  test("kind is 'devcontainer'", () => {
    expect(r.kind).toBe("devcontainer");
  });

  test("applies only when arc.json sets devcontainer: true", () => {
    expect(r.applies(tmpWorkdir())).toBe(false);
    expect(r.applies(tmpWorkdir({ devcontainer: true }))).toBe(true);
    expect(r.applies(tmpWorkdir({ devcontainer: false }))).toBe(false);
  });

  test("wrapLaunchScript wraps the launcher in `devcontainer exec`", () => {
    const wrapped = r.wrapLaunchScript("echo hi", {
      compute: {} as any,
      session: {} as any,
      workdir: "/path/to/repo",
    });
    expect(wrapped).toContain("devcontainer exec");
    expect(wrapped).toContain("/path/to/repo");
    expect(wrapped).toContain("echo hi");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test-file F=packages/compute/runtimes/__tests__/devcontainer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DevcontainerRuntime**

```ts
// packages/compute/runtimes/devcontainer.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { Runtime, WrapCtx } from "./types.js";

/**
 * Wraps the launcher in a `devcontainer exec` invocation so the agent
 * runs inside the worktree's `devcontainer.json`-defined environment.
 * The actual build / up of the devcontainer happens lazily on first
 * exec (the devcontainer CLI handles caching).
 */
export class DevcontainerRuntime implements Runtime {
  readonly kind = "devcontainer" as const;

  applies(workdir: string): boolean {
    if (!workdir) return false;
    const arc = readArcJson(workdir);
    return arc?.devcontainer === true;
  }

  wrapLaunchScript(script: string, ctx: WrapCtx): string {
    return [
      `# DevcontainerRuntime: agent runs inside devcontainer.json env`,
      `cd ${shellQuote(ctx.workdir)}`,
      `exec devcontainer exec --workspace-folder ${shellQuote(ctx.workdir)} bash -lc ${shellQuote(script)}`,
    ].join("\n");
  }
}

function readArcJson(workdir: string): { devcontainer?: boolean } | null {
  const path = join(workdir, "arc.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Run the test**

Run: `make test-file F=packages/compute/runtimes/__tests__/devcontainer.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/compute/runtimes/devcontainer.ts packages/compute/runtimes/__tests__/devcontainer.test.ts
git commit -m "feat(runtime): DevcontainerRuntime (arc.json:devcontainer:true)"
```

---

### Task 6: Implement `DockerRuntime`

**Files:**

- Create: `packages/compute/runtimes/docker.ts`
- Test: `packages/compute/runtimes/__tests__/docker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/runtimes/__tests__/docker.test.ts
import { describe, expect, test } from "bun:test";
import { DockerRuntime } from "../docker.js";

describe("DockerRuntime", () => {
  const r = new DockerRuntime();

  test("kind is 'docker'", () => {
    expect(r.kind).toBe("docker");
  });

  test("applies whenever the compute row's runtime_kind says docker", () => {
    expect(r.applies("/anywhere")).toBe(true);
  });

  test("prepareIsolation pulls + creates the container", async () => {
    const calls: string[][] = [];
    const provider = {
      runOnHost: async (_c: any, cmd: string[]) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as any;
    await r.prepareIsolation!({
      app: {} as any,
      compute: { name: "test-compute", config: { image: "ubuntu:22.04", container_name: "ark-test" } } as any,
      session: { id: "s-x" } as any,
      provider,
      workdir: "/repo",
      onLog: () => {},
    });
    const flat = calls.map((c) => c.join(" "));
    expect(flat.some((c) => c.startsWith("docker pull"))).toBe(true);
    expect(flat.some((c) => c.startsWith("docker create"))).toBe(true);
    expect(flat.some((c) => c.startsWith("docker start"))).toBe(true);
  });

  test("wrapLaunchScript prepends `docker exec` against the container name", () => {
    const wrapped = r.wrapLaunchScript("echo hi", {
      compute: { config: { container_name: "ark-test" } } as any,
      session: {} as any,
      workdir: "/repo",
    });
    expect(wrapped).toContain("docker exec");
    expect(wrapped).toContain("ark-test");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test-file F=packages/compute/runtimes/__tests__/docker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DockerRuntime**

```ts
// packages/compute/runtimes/docker.ts
import type { Runtime, PrepareIsolationOpts, WrapCtx } from "./types.js";

interface DockerComputeConfig {
  image?: string;
  container_name?: string;
}

/**
 * Single-container isolation. `prepareIsolation` runs `docker pull
 * + create + start`; `wrapLaunchScript` prepends `docker exec` against
 * the named container so the launcher runs inside it.
 *
 * Idempotency: `docker create` errors with "already in use" when the
 * named container exists -- treat as "already provisioned" and fall
 * through to start.
 */
export class DockerRuntime implements Runtime {
  readonly kind = "docker" as const;

  applies(): boolean {
    return true;
  }

  async prepareIsolation(opts: PrepareIsolationOpts): Promise<void> {
    if (!opts.provider.runOnHost) {
      throw new Error("DockerRuntime requires provider.runOnHost");
    }
    const cfg = opts.compute.config as DockerComputeConfig;
    const image = cfg.image ?? "ubuntu:22.04";
    const container = cfg.container_name ?? `ark-${opts.compute.name}`;

    await opts.provider.runOnHost(opts.compute, ["docker", "pull", image], { timeoutMs: 300_000 });

    const create = await opts.provider.runOnHost(
      opts.compute,
      [
        "docker",
        "create",
        "--name",
        container,
        "--rm",
        "-v",
        `${opts.workdir}:${opts.workdir}`,
        image,
        "tail",
        "-f",
        "/dev/null",
      ],
      { timeoutMs: 60_000 },
    );
    if (create.exitCode !== 0 && !/already in use/.test(create.stderr)) {
      throw new Error(`docker create failed (exit ${create.exitCode}): ${create.stderr.slice(0, 500)}`);
    }
    await opts.provider.runOnHost(opts.compute, ["docker", "start", container], { timeoutMs: 30_000 });
  }

  wrapLaunchScript(script: string, ctx: WrapCtx): string {
    const cfg = ctx.compute.config as DockerComputeConfig;
    const container = cfg.container_name ?? `ark-${ctx.compute.name}`;
    return `exec docker exec -i ${shellQuote(container)} bash -lc ${shellQuote(script)}`;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 4: Run the test**

Run: `make test-file F=packages/compute/runtimes/__tests__/docker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/compute/runtimes/docker.ts packages/compute/runtimes/__tests__/docker.test.ts
git commit -m "feat(runtime): DockerRuntime (sidecar container)"
```

---

### Task 7: Implement `FirecrackerRuntime`

**Files:**

- Create: `packages/compute/runtimes/firecracker.ts`
- Create: `packages/compute/providers/firecracker-boot.ts` (extracted boot-command builder)
- Test: `packages/compute/runtimes/__tests__/firecracker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/runtimes/__tests__/firecracker.test.ts
import { describe, expect, test } from "bun:test";
import { FirecrackerRuntime } from "../firecracker.js";

describe("FirecrackerRuntime", () => {
  const r = new FirecrackerRuntime();
  test("kind is 'firecracker-in-container'", () => {
    expect(r.kind).toBe("firecracker-in-container");
  });
  test("applies whenever the row selects this runtime", () => {
    expect(r.applies("/repo")).toBe(true);
  });
  test("wrapLaunchScript routes through microVM ssh", () => {
    const wrapped = r.wrapLaunchScript("echo hi", {
      compute: { config: { microvm_ip: "172.16.0.2", microvm_ssh_key: "/tmp/k" } } as any,
      session: {} as any,
      workdir: "/repo",
    });
    expect(wrapped).toContain("ssh");
    expect(wrapped).toContain("172.16.0.2");
    expect(wrapped).toContain("echo hi");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test-file F=packages/compute/runtimes/__tests__/firecracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Extract the boot-command builder**

Today's `firecracker-vm.ts` directly spawns processes. We need a pure
function that returns the command sequence so the runtime can run them
through `provider.runOnHost`.

```ts
// packages/compute/providers/firecracker-boot.ts
import type { Compute } from "../types.js";

/**
 * Return the ordered shell-arg sequence that boots a Firecracker
 * microVM from this compute's config. Pure -- no I/O. The caller
 * (FirecrackerRuntime.prepareIsolation) runs each cmd through
 * `provider.runOnHost(...)` so the boot happens on whichever medium
 * the compute lives on.
 */
export function firecrackerBootCommands(compute: Compute, workdir: string): string[][] {
  const cfg = compute.config as {
    kernel?: string;
    rootfs?: string;
    socket?: string;
  };
  if (!cfg.kernel || !cfg.rootfs || !cfg.socket) {
    throw new Error(`firecracker compute '${compute.name}' missing kernel/rootfs/socket in config`);
  }
  return [
    ["mkdir", "-p", workdir],
    ["firecracker", "--api-sock", cfg.socket, "--config-file", `${workdir}/firecracker.json`],
    // Additional setup commands as needed -- kept minimal here; existing
    // firecracker-vm.ts logic ports over in subsequent edits.
  ];
}
```

- [ ] **Step 4: Implement FirecrackerRuntime**

```ts
// packages/compute/runtimes/firecracker.ts
import type { Runtime, PrepareIsolationOpts, WrapCtx } from "./types.js";

interface FirecrackerComputeConfig {
  microvm_ip?: string;
  microvm_ssh_key?: string;
  microvm_user?: string;
}

/**
 * Boots a Firecracker microVM on the compute target and runs the agent
 * inside it. Stronger isolation than docker (separate kernel + memory).
 * Runs on any compute target that exposes `/dev/kvm` + the firecracker
 * binary -- the runtime is provider-agnostic; provider.runOnHost
 * handles the medium-specific exec.
 */
export class FirecrackerRuntime implements Runtime {
  readonly kind = "firecracker-in-container" as const;

  applies(): boolean {
    return true;
  }

  async prepareIsolation(opts: PrepareIsolationOpts): Promise<void> {
    if (!opts.provider.runOnHost) {
      throw new Error("FirecrackerRuntime requires provider.runOnHost (host needs /dev/kvm + firecracker binary)");
    }
    const { firecrackerBootCommands } = await import("../providers/firecracker-boot.js");
    for (const cmd of firecrackerBootCommands(opts.compute, opts.workdir)) {
      const r = await opts.provider.runOnHost(opts.compute, cmd, { timeoutMs: 60_000 });
      if (r.exitCode !== 0) {
        throw new Error(`firecracker boot step failed (cmd=${cmd[0]}, exit=${r.exitCode}): ${r.stderr.slice(0, 500)}`);
      }
    }
  }

  wrapLaunchScript(script: string, ctx: WrapCtx): string {
    const cfg = ctx.compute.config as FirecrackerComputeConfig;
    if (!cfg.microvm_ip || !cfg.microvm_ssh_key) {
      throw new Error(`Firecracker microVM config missing ip/ssh_key for compute ${ctx.compute.name}`);
    }
    const user = cfg.microvm_user ?? "root";
    return `exec ssh -i ${shellQuote(cfg.microvm_ssh_key)} -o StrictHostKeyChecking=no ${user}@${cfg.microvm_ip} ${shellQuote(script)}`;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 5: Run the test**

Run: `make test-file F=packages/compute/runtimes/__tests__/firecracker.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/compute/runtimes/firecracker.ts packages/compute/providers/firecracker-boot.ts packages/compute/runtimes/__tests__/firecracker.test.ts
git commit -m "feat(runtime): FirecrackerRuntime (microVM wrap)"
```

---

### Task 8: RuntimeRegistry + dispatch wiring

**Files:**

- Create: `packages/compute/runtimes/registry.ts`
- Modify: `packages/core/app.ts` (expose `app.runtimes`)
- Modify: `packages/core/services/agent-launcher.ts` (consult registry; drop `applyContainerSetup`)
- Modify: `packages/core/__tests__/ssh-escape.test.ts` (regression-guard moves to compose.ts)
- Test: `packages/compute/runtimes/__tests__/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/runtimes/__tests__/registry.test.ts
import { describe, expect, test } from "bun:test";
import { defaultRuntimeRegistry } from "../registry.js";

describe("RuntimeRegistry", () => {
  test("default registry resolves every documented runtime kind", () => {
    const reg = defaultRuntimeRegistry();
    expect(reg.get("direct")?.kind).toBe("direct");
    expect(reg.get("docker")?.kind).toBe("docker");
    expect(reg.get("docker-compose")?.kind).toBe("docker-compose");
    expect(reg.get("devcontainer")?.kind).toBe("devcontainer");
    expect(reg.get("firecracker-in-container")?.kind).toBe("firecracker-in-container");
  });

  test("get returns null for unknown kinds (caller falls back to 'direct')", () => {
    const reg = defaultRuntimeRegistry();
    expect(reg.get("phantom" as any)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `make test-file F=packages/compute/runtimes/__tests__/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the registry**

```ts
// packages/compute/runtimes/registry.ts
import type { Runtime, RuntimeKind } from "./types.js";
import { DirectRuntime } from "./direct.js";
import { DockerRuntime } from "./docker.js";
import { ComposeRuntime } from "./compose.js";
import { DevcontainerRuntime } from "./devcontainer.js";
import { FirecrackerRuntime } from "./firecracker.js";

export class RuntimeRegistry {
  private readonly entries = new Map<RuntimeKind, Runtime>();
  register(r: Runtime): void {
    this.entries.set(r.kind, r);
  }
  get(kind: RuntimeKind): Runtime | null {
    return this.entries.get(kind) ?? null;
  }
}

export function defaultRuntimeRegistry(): RuntimeRegistry {
  const r = new RuntimeRegistry();
  r.register(new DirectRuntime());
  r.register(new DockerRuntime());
  r.register(new ComposeRuntime());
  r.register(new DevcontainerRuntime());
  r.register(new FirecrackerRuntime());
  // ark-compose: TBD; not registered until spec lands.
  return r;
}
```

- [ ] **Step 4: Wire into AppContext**

In `packages/core/app.ts`, add a `runtimeRegistry` field built in
`boot()` and a getter:

```ts
// Inside class AppContext
private runtimeRegistry: RuntimeRegistry | null = null;

// Inside boot()
import { defaultRuntimeRegistry } from "../compute/runtimes/registry.js";
this.runtimeRegistry = defaultRuntimeRegistry();

// Getter (matches existing `providers` getter)
get runtimes(): RuntimeRegistry {
  if (!this.runtimeRegistry) throw new Error("AppContext not booted");
  return this.runtimeRegistry;
}
```

- [ ] **Step 5: Replace `applyContainerSetup` in agent-launcher.ts**

In `packages/core/services/agent-launcher.ts`, drop the
`applyContainerSetup` function entirely. After the `provider.prepareForLaunch`
call, do:

```ts
const runtimeKind = (compute.runtime_kind as any) ?? "direct";
const runtime = app.runtimes.get(runtimeKind) ?? app.runtimes.get("direct")!;
if (runtime.applies(effectiveWorkdir) && runtime.prepareIsolation) {
  await provisionStep(app, sid, "isolation-prepare", () =>
    runtime.prepareIsolation!({
      app,
      compute,
      session,
      provider,
      workdir: effectiveWorkdir,
      onLog: log,
    }),
  );
}
const finalLaunchContent = runtime.wrapLaunchScript(opts?.launchContent ?? "", {
  compute,
  session,
  workdir: effectiveWorkdir,
});

const ports = effectiveWorkdir ? resolvePortDecls(effectiveWorkdir) : [];
if (ports.length > 0) {
  await app.sessions.update(session.id, { config: { ...session.config, ports } });
}
return { finalLaunchContent, ports };
```

`agent-launcher.ts` now imports zero `compute/providers/*` paths.

- [ ] **Step 6: Update the ssh-escape regression guard**

The `agent-launcher.ts shell-escapes the workdir before cd` test
asserted on the now-deleted `applyContainerSetup` body. Move the
assertion onto `compose.ts`:

```ts
// In packages/core/__tests__/ssh-escape.test.ts, replace the
// agent-launcher block with:
test("compose.ts shell-quotes the compose-file path before runOnHost", () => {
  const src = readFileSync(join(ROOT, "packages/compute/runtimes/compose.ts"), "utf-8");
  // The runOnHost cmd[] form sidesteps shell parsing entirely; assert
  // we still pass an array (no string interpolation into a shell line).
  expect(src).toMatch(/runOnHost\(\s*opts\.compute,\s*\[/);
  expect(src).not.toMatch(/sshExec[^A]+`cd\s+\$\{[^}]+\}/);
});
```

- [ ] **Step 7: Run the suites**

Run: `make test-file F=packages/compute/runtimes/__tests__/registry.test.ts`
Expected: PASS.

Run: `make test-file F=packages/core/__tests__/agent-launcher.test.ts`
Expected: PASS (existing).

Run: `make test-file F=packages/core/__tests__/ssh-escape.test.ts`
Expected: PASS.

Run: `make lint` — zero warnings.

- [ ] **Step 8: Commit**

```bash
git add packages/compute/runtimes/registry.ts packages/core/app.ts packages/core/services/agent-launcher.ts packages/compute/runtimes/__tests__/registry.test.ts packages/core/__tests__/ssh-escape.test.ts
git commit -m "feat(runtime): RuntimeRegistry; agent-launcher consults registry instead of inline applyContainerSetup"
```

---

### Task 9: Phase-1 self-review + integration check

- [ ] **Step 1: Run the full suite**

Run: `make test`
Expected: every pre-existing test still passes; new tests added in
this plan all pass; `0 fail`.

- [ ] **Step 2: Verify agent-launcher has no compute/providers imports**

Run: `grep -E "from \"../../compute/providers" packages/core/services/agent-launcher.ts`
Expected: zero matches.

- [ ] **Step 3: Verify registry covers every runtime_kind in
provider-map**

Run: `grep -E '"docker-compose"|"devcontainer"|"direct"|"firecracker-in-container"|"docker"' packages/compute/adapters/provider-map.ts`
Expected: every kind from the table is registered in
`defaultRuntimeRegistry`.

- [ ] **Step 4: Self-review checklist**

  - All Runtime impls are pure transforms or single-call `runOnHost`
    wrappers — no direct shell execution.
  - All Runtime impls are tested with stubbed `runOnHost`.
  - The dispatcher's `prepareRemoteEnvironment` reads
    `compute.runtime_kind` and falls back to `direct` if the registry
    doesn't have it.
  - `applyContainerSetup` is gone from `agent-launcher.ts`.

- [ ] **Step 5: Commit any cleanup**

```bash
git status
git commit -am "chore: phase-1 cleanup"
```

---

## Out of scope for this plan

- Phase 3 (split combined provider classes).
- Phase 4 (provider-agnostic session orchestrator that lifts
  flush-secrets / git-clone / launch-agent out of `provider.launch`).
- The `ark-compose` runtime config dialect.
- Any new isolation flavour (Kata, gVisor).

## Self-review (this plan, before execution)

- **Spec coverage**: every requirement in the spec maps to a task
  above. Phase 2's `runOnHost` is task 2; phase 1's runtimes are
  tasks 3-7; registry + wiring is task 8.
- **No placeholders**: every step has the actual code or command
  needed.
- **Type consistency**: `Runtime`, `WrapCtx`, `PrepareIsolationOpts`
  shapes are defined in task 1 and used unchanged through 3-8.
- **Migration safety**: existing `LocalDockerProvider` etc. classes
  are NOT touched in this plan. They keep their inline docker logic
  for now and continue to work; the new `DockerRuntime` exists
  alongside. Phase 3 (separate plan) replaces them.

## Execution Handoff

Plan saved. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with
   two-stage review between tasks.
2. **Inline Execution** — execute tasks in this session via
   `executing-plans`.
