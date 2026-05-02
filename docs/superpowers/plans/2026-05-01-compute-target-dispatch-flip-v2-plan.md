# Flip dispatch to `ComputeTarget` (v2) — Implementation Plan

> **Supersedes:** `2026-05-01-compute-target-dispatch-flip-plan.md`.
> The v1 plan undersold the abstraction work needed to flip dispatch.
> A subagent dry-run on v1 surfaced five gaps: the live `provider.launch`
> path does work that has no home in the current `Compute` / `Runtime`
> interface (placement flush, remote git-clone, workdir translation,
> auto-start, transport-on-rehydrate). v2 widens the `Compute`
> interface to cover them, then flips the executors.

> **For agentic workers:** REQUIRED SUB-SKILL:
> superpowers:subagent-driven-development OR
> superpowers:executing-plans.

**Goal:** Make the live dispatch path consume `ComputeTarget`
(Compute × Runtime composition) end-to-end. Today the legacy
`ComputeProvider.launch` path on `LocalWorktreeProvider`,
`RemoteWorktreeProvider`, etc. owns: auto-start, transport setup,
placement flush, remote git-clone, agent launch. v2 distributes those
responsibilities onto the new `Compute` interface so the executor
flip in tasks 7-8 becomes mechanical.

**Architecture context:**
`docs/superpowers/specs/2026-05-01-compute-runtime-split-design.md`
covers the architectural model. The existing `Compute` shape (in
`packages/compute/core/types.ts`) needs four optional methods added
to cover what the legacy provider does today.

**Tech stack:** TypeScript (strict: false), Bun. Touches:

- `packages/compute/core/types.ts` (interface widening)
- `packages/compute/core/{local,ec2,k8s,k8s-kata,firecracker/compute}.ts`
- `packages/core/services/dispatch/target-lifecycle.ts`
- `packages/core/services/dispatch/target-resolver.ts`
- `packages/core/executors/claude-code.ts`
- `packages/core/services/agent-launcher.ts` (delete)
- `packages/compute/providers/remote-arkd.ts` (slim down)

**Out of scope:**

- Adding new `Compute` or `Runtime` impls (Kata done, gVisor TBD).
- Removing the legacy `ComputeProvider` interface entirely. Adapter
  stays live; legacy classes stay as thin shims.
- The `ark-compose` runtime config dialect.
- The `agent-sdk` executor — it's local-only and never calls
  `provider.launch`. v1's task 5 was wrong; v2 drops it.

---

## Gap fixes (tasks 1-5): widen `Compute` to cover provider responsibilities

Each new method is **optional** on the interface so impls that don't
need it (e.g. `LocalCompute.flushPlacement` is a no-op) can omit.

### Task 1: Add `Compute.ensureReachable(handle, opts)`

The conductor's connection to the compute (SSH tunnel for EC2, port-
forward for k8s) needs to be alive on every dispatch — both fresh
provision AND rehydrate. Today it's baked into `EC2Compute.provision`
which only fires once. Move it out so multi-stage dispatch (verify →
pr → merge) doesn't silently lose the transport.

**Files:**

- Modify: `packages/compute/core/types.ts` (add method to interface)
- Modify: `packages/compute/core/local.ts` (no-op impl)
- Modify: `packages/compute/core/ec2.ts` (extract transport setup)
- Modify: `packages/compute/core/k8s.ts` (kubectl port-forward setup)
- Modify: `packages/compute/core/firecracker/compute.ts` (TUN/TAP / vsock setup)
- Test: `packages/compute/core/__tests__/ensure-reachable.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/core/__tests__/ensure-reachable.test.ts
import { describe, expect, test } from "bun:test";
import { LocalCompute } from "../local.js";

describe("Compute.ensureReachable", () => {
  test("LocalCompute is a no-op (always reachable)", async () => {
    const c = new LocalCompute({} as never);
    if (c.ensureReachable) {
      await c.ensureReachable(
        { kind: "local", name: "local", meta: {} },
        { app: {} as never, sessionId: "s-test" },
      );
    }
    // No throw, no side effects.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Add to interface**

```ts
// packages/compute/core/types.ts -- add to interface Compute
/**
 * Make the compute reachable from the conductor. Idempotent. Called
 * on every dispatch (fresh provision AND rehydrated handle).
 *
 * Provider-specific behaviour:
 *   - LocalCompute: no-op (arkd is on the same host).
 *   - EC2Compute: SSH-over-SSM connectivity check, forward `-L`
 *     tunnel, arkd /health probe, events-stream subscribe. Mutates
 *     `handle.meta.ec2.arkdLocalPort` so the next call to
 *     `getArkdUrl(h)` resolves to the new tunnel.
 *   - K8sCompute: kubectl port-forward, arkd /health probe.
 *   - FirecrackerCompute: TAP bridge wiring, microVM ssh probe.
 *
 * Implementations are responsible for emitting `provisioning_step`
 * events for their internal phases via `provisionStep`.
 *
 * Optional: omit on impls that need no transport setup.
 */
ensureReachable?(h: ComputeHandle, opts: EnsureReachableOpts): Promise<void>;
```

```ts
// packages/compute/core/types.ts -- new opts type
export interface EnsureReachableOpts {
  app: import("../../core/app.js").AppContext;
  sessionId: string;
  onLog?: (msg: string) => void;
}
```

- [ ] **Step 3: Implement on LocalCompute (no-op)**

In `packages/compute/core/local.ts`, add to the class:

```ts
async ensureReachable(): Promise<void> {
  // Local arkd is on the same host as the conductor; nothing to do.
}
```

- [ ] **Step 4: Implement on EC2Compute (extract from provision)**

The SSH tunnel + arkd probe + events-consumer logic currently lives
inside `EC2Compute.provision` (around lines 422-473). Extract into a
private `setupTransport(handle, opts)` method, call it from BOTH
`provision` (for fresh) AND `ensureReachable` (for both fresh and
rehydrate).

The transport setup must be idempotent: re-running it should reuse
the existing forward tunnel if one is alive (the existing
`setupForwardTunnel` already does this via `findForwardTunnelPid`).

After the move, `EC2Compute.provision` ends after the cloud-init
ready-marker check — transport setup runs in `ensureReachable`
afterwards.

- [ ] **Step 5: Implement on K8sCompute**

Mirror EC2: extract pod-readiness + kubectl port-forward + arkd
/health probe into `ensureReachable`. Call from both `provision` and
`ensureReachable`.

- [ ] **Step 6: Implement on FirecrackerCompute**

Microvm boot is part of `provision` (the kernel boot is one-shot).
For `ensureReachable`, only the TAP bridge + microvm ssh probe need
to re-run on rehydrate. Idempotent.

- [ ] **Step 7: Run tests + lint + commit**

```bash
make test-file F=packages/compute/core/__tests__/ensure-reachable.test.ts
make test-file F=packages/compute/__tests__/local-compute.test.ts
make test-file F=packages/compute/__tests__/ec2-provision.test.ts
make lint
git add packages/compute/core packages/compute/core/__tests__/ensure-reachable.test.ts
git commit -m "feat(compute): Compute.ensureReachable (idempotent transport setup)"
```

---

### Task 2: Add `Compute.resolveWorkdir(handle, session)`

Today `claude-code.ts` calls `provider.resolveWorkdir(compute, session)`
to translate conductor-side workdir paths to compute-side paths. The
result feeds tmux's `-c` flag and the launcher's `cd`. Pure transform.

**Files:**

- Modify: `packages/compute/core/types.ts` (add method)
- Modify: `packages/compute/core/{local,ec2,k8s,k8s-kata,firecracker/compute}.ts`
- Test: `packages/compute/core/__tests__/resolve-workdir.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/core/__tests__/resolve-workdir.test.ts
import { describe, expect, test } from "bun:test";
import { LocalCompute } from "../local.js";
import { EC2Compute } from "../ec2.js";

describe("Compute.resolveWorkdir", () => {
  test("LocalCompute returns null (caller falls back to host workdir)", () => {
    const c = new LocalCompute({} as never);
    if (c.resolveWorkdir) {
      const r = c.resolveWorkdir({ kind: "local", name: "x", meta: {} }, { workdir: "/Users/me/repo" } as never);
      expect(r).toBeNull();
    }
  });

  test("EC2Compute returns the remote-host path", () => {
    const c = new EC2Compute({} as never);
    if (c.resolveWorkdir) {
      const r = c.resolveWorkdir(
        { kind: "ec2", name: "ec2-test", meta: { ec2: { remoteHome: "/home/ubuntu" } } },
        { id: "s-abc", config: { remoteRepo: "git@example.com:org/repo.git" } } as never,
      );
      expect(r).toBe("/home/ubuntu/Projects/s-abc/repo");
    }
  });
});
```

- [ ] **Step 2: Add to interface**

```ts
// packages/compute/core/types.ts
/**
 * Translate a conductor-side workdir path to the path the compute
 * exposes for the agent's `cd` and tmux `-c`. Pure transform; no I/O.
 *
 *   - LocalCompute: returns null (caller falls back to session.workdir).
 *   - EC2Compute: returns `${remoteHome}/Projects/<sid>/<repo>`.
 *   - K8sCompute: returns `/workspace/<sid>/<repo>`.
 *
 * Optional: impls that share the conductor's filesystem layout omit.
 */
resolveWorkdir?(h: ComputeHandle, session: Session): string | null;
```

- [ ] **Step 3: Implement on each compute kind**

Move the body from each legacy provider's `resolveWorkdir` into the
matching Compute impl. Today's implementations live on the legacy
provider classes (e.g. `RemoteWorktreeProvider.resolveWorkdir`); copy
the logic onto `EC2Compute.resolveWorkdir` and `K8sCompute.resolveWorkdir`.

- [ ] **Step 4: Run tests + lint + commit**

```bash
make test-file F=packages/compute/core/__tests__/resolve-workdir.test.ts
git commit -m "feat(compute): Compute.resolveWorkdir (path translation)"
```

---

### Task 3: Add `Compute.prepareWorkspace(handle, opts)`

Per-session workspace setup on the compute target. Today
`RemoteWorktreeProvider.launch` does `mkdir -p` + `git clone` between
`flushDeferredPlacement` and `launchAgent`. Move it onto `Compute`
because the operation is medium-specific (arkd HTTP for EC2/k8s, fs
for local).

**Files:**

- Modify: `packages/compute/core/types.ts`
- Modify: `packages/compute/core/{local,ec2,k8s}.ts`
- Test: `packages/compute/core/__tests__/prepare-workspace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/core/__tests__/prepare-workspace.test.ts
import { describe, expect, test } from "bun:test";
import { LocalCompute } from "../local.js";

describe("Compute.prepareWorkspace", () => {
  test("LocalCompute is a no-op when source is local", async () => {
    const c = new LocalCompute({} as never);
    if (c.prepareWorkspace) {
      await c.prepareWorkspace(
        { kind: "local", name: "x", meta: {} },
        { source: "/Users/me/local/repo", remoteWorkdir: null, sessionId: "s-test" },
      );
    }
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Add to interface**

```ts
// packages/compute/core/types.ts
export interface PrepareWorkspaceOpts {
  /** Source URL or path to clone (e.g. session.config.remoteRepo). */
  source: string | null;
  /** Resolved remote workdir from `Compute.resolveWorkdir`. Null on local. */
  remoteWorkdir: string | null;
  sessionId: string;
  onLog?: (msg: string) => void;
}

/**
 * Set up the per-session workspace on the compute. Idempotent on the
 * leaf path (skip if already cloned).
 *
 *   - LocalCompute: no-op (worktree is already on the host).
 *   - EC2Compute / K8sCompute: mkdir + git clone via arkd HTTP.
 */
prepareWorkspace?(h: ComputeHandle, opts: PrepareWorkspaceOpts): Promise<void>;
```

- [ ] **Step 3: Implement on EC2Compute**

Move the body from `RemoteWorktreeProvider.launch`:

```ts
async prepareWorkspace(h: ComputeHandle, opts: PrepareWorkspaceOpts): Promise<void> {
  if (!opts.source || !opts.remoteWorkdir) return;
  const arkdUrl = this.getArkdUrl(h);
  const client = new ArkdClient(arkdUrl, { token: process.env.ARK_ARKD_TOKEN });
  await client.run({
    command: "mkdir",
    args: ["-p", opts.remoteWorkdir.replace(/\/[^/]+$/, "")],
    timeout: 15_000,
  });
  await client.run({ command: "git", args: ["clone", opts.source, opts.remoteWorkdir], timeout: 120_000 });
}
```

- [ ] **Step 4: Implement on K8sCompute (same shape)**

- [ ] **Step 5: Run + commit**

```bash
make test-file F=packages/compute/core/__tests__/prepare-workspace.test.ts
git commit -m "feat(compute): Compute.prepareWorkspace (mkdir + git clone via arkd)"
```

---

### Task 4: Add `Compute.flushPlacement(handle, opts)`

Replays the deferred typed-secret queue onto the compute's medium.
Today `RemoteWorktreeProvider.launch` calls
`flushDeferredPlacement(compute, opts)` which pipes through SSH; the
new method delegates to whatever transport the compute owns.

**Files:**

- Modify: `packages/compute/core/types.ts`
- Modify: `packages/compute/core/{local,ec2,k8s}.ts`
- Test: `packages/compute/core/__tests__/flush-placement.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/compute/core/__tests__/flush-placement.test.ts
import { describe, expect, test } from "bun:test";
import { DeferredPlacementCtx } from "../../../core/secrets/deferred-placement-ctx.js";
import { LocalCompute } from "../local.js";

describe("Compute.flushPlacement", () => {
  test("LocalCompute flushes onto a local PlacementCtx", async () => {
    const c = new LocalCompute({} as never);
    const placement = new DeferredPlacementCtx();
    placement.queueWriteFile("/tmp/x", 0o600, new TextEncoder().encode("v"));
    if (c.flushPlacement) {
      await c.flushPlacement(
        { kind: "local", name: "x", meta: {} },
        { placement, sessionId: "s-test" },
      );
    }
    // Local impl flushes synchronously; assert queue drained.
    expect(placement.queuedOps).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Add to interface**

```ts
// packages/compute/core/types.ts
export interface FlushPlacementOpts {
  placement: import("../../core/secrets/deferred-placement-ctx.js").DeferredPlacementCtx;
  sessionId: string;
  onLog?: (msg: string) => void;
}

/**
 * Replay queued typed-secret placement ops onto the compute's medium.
 * Reads the deferred queue from `opts.placement` and delivers each
 * write/append/setEnv via the medium-specific transport (SSH for EC2,
 * kubectl cp for k8s, fs writes for local).
 *
 * Idempotent: appendFile is marker-keyed; writeFile overwrites.
 *
 * Optional: omit on computes that have no out-of-band placement
 * delivery (none today; every Compute kind needs this if any session
 * declares a file-typed secret).
 */
flushPlacement?(h: ComputeHandle, opts: FlushPlacementOpts): Promise<void>;
```

- [ ] **Step 3: Implement on each compute**

Each `Compute.flushPlacement` constructs the appropriate
`PlacementCtx` (LocalPlacementCtx / EC2PlacementCtx / K8sPlacementCtx)
and calls `placement.replayOnto(realCtx)`. The body of today's
`RemoteWorktreeProvider.flushDeferredPlacement` moves verbatim to
`EC2Compute.flushPlacement`.

- [ ] **Step 4: Run + commit**

```bash
make test-file F=packages/compute/core/__tests__/flush-placement.test.ts
git commit -m "feat(compute): Compute.flushPlacement (typed-secret delivery via compute medium)"
```

---

### Task 5: Update `runTargetLifecycle` to call the new methods

The lifecycle gains four new optional steps before `runtime-prepare`:
compute-start (auto-start) → ensure-reachable → prepare-workspace →
flush-secrets → runtime-prepare → launch-agent.

**Files:**

- Modify: `packages/core/services/dispatch/target-lifecycle.ts`
- Modify: `packages/core/services/dispatch/__tests__/target-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// Add to target-lifecycle.test.ts:
test("calls auto-start when handle.meta indicates stopped state", async () => {
  // Stub compute that records its lifecycle calls.
  const calls: string[] = [];
  const fakeCompute = {
    start: async () => { calls.push("start"); },
    ensureReachable: async () => { calls.push("ensure-reachable"); },
    prepareWorkspace: async () => { calls.push("prepare-workspace"); },
    flushPlacement: async () => { calls.push("flush"); },
  };
  const target = {
    compute: fakeCompute,
    prepare: async () => { calls.push("prepare"); },
    launchAgent: async () => { calls.push("launch"); return { sessionName: "x" }; },
  } as unknown as ComputeTarget;
  // ... drive runTargetLifecycle ...
  expect(calls).toEqual([
    "start", "ensure-reachable", "prepare-workspace", "flush", "prepare", "launch"
  ]);
});
```

- [ ] **Step 2: Update the helper signature**

```ts
export interface RunTargetLifecycleOpts {
  prepareCtx?: Partial<PrepareCtx>;
  /** When true, auto-start the compute if it's stopped. Default true. */
  autoStart?: boolean;
  /** Sources for prepareWorkspace (cloneSource + resolved remote workdir). */
  workspace?: { source: string | null; remoteWorkdir: string | null };
  /** Deferred placement queue from `buildLaunchEnv`. */
  placement?: DeferredPlacementCtx;
  /** Whether the rehydrated compute may have lost its transport. Default true. */
  ensureReachable?: boolean;
}
```

- [ ] **Step 3: Implement the expanded flow**

Each new step is wrapped in `provisionStep` so the timeline shows the
full trail. Steps that have no impl on the compute are skipped (the
optional method check).

- [ ] **Step 4: Run + commit**

```bash
make test-file F=packages/core/services/dispatch/__tests__/target-lifecycle.test.ts
git commit -m "feat(dispatch): runTargetLifecycle wires auto-start + ensure-reachable + prepareWorkspace + flushPlacement"
```

---

## Executor flip (tasks 6-8)

### Task 6: claude-code executor → ComputeTarget

Now mechanical because tasks 1-5 give every responsibility a home.

**Files:**

- Modify: `packages/core/executors/claude-code.ts`

- [ ] **Step 1: Replace the remote-dispatch block**

```ts
// In packages/core/executors/claude-code.ts, replace the
// `if (compute && provider && !provider.supportsWorktree)` block:

if (compute && provider && !provider.supportsWorktree) {
  const { resolveTargetAndHandle } = await import("../services/dispatch/target-resolver.js");
  const { runTargetLifecycle } = await import("../services/dispatch/target-lifecycle.js");
  const { resolvePortDecls } = await import("../../compute/arc-json.js");

  const { target, handle } = await resolveTargetAndHandle(app, session);
  if (!target || !handle) {
    return { ok: false, handle: "", message: "no compute target resolved for remote dispatch" };
  }

  const remoteWorkdir = target.compute.resolveWorkdir?.(handle, session) ?? effectiveWorkdir;
  const ports = remoteWorkdir ? resolvePortDecls(remoteWorkdir) : [];
  if (ports.length > 0) {
    await app.sessions.update(session.id, { config: { ...session.config, ports } });
  }

  const cloneSource = (session.config as { remoteRepo?: string } | null)?.remoteRepo ?? session.repo ?? null;

  const agentHandle = await runTargetLifecycle(
    app,
    session.id,
    target,
    handle,
    { tmuxName, workdir: remoteWorkdir, launcherContent: launchContent, ports },
    {
      prepareCtx: { workdir: remoteWorkdir, onLog: log },
      workspace: { source: cloneSource, remoteWorkdir },
      placement: opts.placement,
    },
  );
  return { ok: true, handle: agentHandle.sessionName };
}
```

- [ ] **Step 2: Run dispatch suites**

```bash
make test-file F=packages/core/__tests__/e2e-dispatch-compute.test.ts
make test-file F=packages/core/__tests__/e2e-session-lifecycle.test.ts
make test-file F=packages/core/__tests__/conductor-hooks.test.ts
make lint
```

Iterate.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(dispatch): claude-code executor consumes ComputeTarget"
```

---

### Task 7: Retire interim hooks

After task 6, `prepareRemoteEnvironment` and
`ComputeProvider.prepareForLaunch` should have zero non-test callers.

**Files:**

- Verify: `grep -rn "prepareRemoteEnvironment\|prepareForLaunch" packages/`
- Delete: `packages/core/services/agent-launcher.ts`
- Modify: `packages/compute/types.ts` (drop `prepareForLaunch?` + `PrepareForLaunchOpts`)
- Modify: `packages/compute/providers/remote-arkd.ts` (drop `prepareForLaunch`, slim `launch` down)
- Update: `packages/core/__tests__/ssh-escape.test.ts` (move regression-guard onto docker-compose runtime)
- Audit + delete or rewrite: any test that imports `prepareRemoteEnvironment` directly.

- [ ] **Step 1: Verify zero non-test callers**

```bash
grep -rn "prepareRemoteEnvironment\|prepareForLaunch" packages/ --include="*.ts" 2>/dev/null
```

If anything in non-test code remains, migrate it first.

- [ ] **Step 2: Apply the deletions + slim down**

`RemoteWorktreeProvider.launch` becomes:

```ts
async launch(compute: Compute, session: Session, opts: LaunchOpts): Promise<string> {
  // The actual work is now in EC2Compute.{ensureReachable,prepareWorkspace,flushPlacement} +
  // Runtime.{prepare,launchAgent}, called from runTargetLifecycle. This
  // method exists only as a back-compat shim for callers that haven't
  // migrated yet -- the legacy adapter + ComputeTarget reach the same
  // arkd via target.launchAgent.
  throw new Error("RemoteWorktreeProvider.launch is deprecated; use ComputeTarget");
}
```

(Or leave a delegating impl that constructs the target and calls
through, depending on whether any tests still call it directly.)

- [ ] **Step 3: Lint + full suite**

```bash
make lint
make test
```

Iterate to 0 fail.

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(dispatch): retire agent-launcher.ts + prepareForLaunch (covered by ComputeTarget)"
```

---

### Task 8: Self-review + integration check

- [ ] **Step 1: Verify**

```bash
grep -rn "provider\.launch\b" packages/core/services/ packages/core/executors/ --include="*.ts"
# expected: zero non-test matches

grep -rn "resolveComputeTarget\|runTargetLifecycle\|target\.launchAgent" packages/core/executors/ packages/core/services/dispatch/ 2>/dev/null
# expected: live calls in claude-code.ts and dispatch/

make test-file F=packages/compute/__tests__/legacy-adapter.test.ts
# legacy adapter still works for back-compat
```

- [ ] **Step 2: Live EC2 dispatch smoke**

```bash
./ark server daemon stop && ./ark server daemon start
./ark session start \
  --remote-repo "git@bitbucket.org:paytmteam/pi-event-registry.git" \
  --compute ec2-ssm \
  --flow quick \
  --summary "ComputeTarget v2 smoke"
```

Expected: timeline shows `provisioning_step` events for
`compute-start` (skipped if running), `ensure-reachable`,
`prepare-workspace`, `flush-secrets`, `runtime-prepare`,
`launch-agent` — in that order, all green.

- [ ] **Step 3: Commit final cleanup**

```bash
git status; git commit -am "chore(dispatch): post-flip cleanup"
```

---

## Self-review (this plan)

**Plan-vs-spec coverage:**

| Spec section                          | Task |
| ------------------------------------- | ---- |
| Compute.ensureReachable (transport)   | 1 |
| Compute.resolveWorkdir (path xlate)   | 2 |
| Compute.prepareWorkspace (clone)      | 3 |
| Compute.flushPlacement (secrets)      | 4 |
| Lifecycle composition                 | 5 |
| Executor migration                    | 6 |
| Retirement of interim hooks           | 7 |
| Smoke + final review                  | 8 |

**What v1 got wrong:**

- Treated the executor flip as plumbing. It isn't — the legacy
  provider does work the new abstraction had no place for.
- Said agent-sdk needed migration. It doesn't.
- Didn't notice rehydration would lose the SSH tunnel.

**What v2 fixes:**

- Each missing responsibility gets an explicit subtask + interface
  method.
- `runTargetLifecycle` becomes the single composition point.
- Rehydration works because `ensureReachable` is idempotent and runs
  every dispatch.

**Migration safety:** every new method is OPTIONAL on the interface,
so impls (and the legacy adapter) compile against the widened
interface without touching every Compute kind on day one. Tasks 1-5
land independently. Task 6 is the gated flip. Tasks 7-8 clean up.

## Execution Handoff

Plan saved. Two execution options:

1. **Subagent-Driven** — fresh subagent per task with two-stage
   review. Recommended for tasks 1-4 (mechanical, well-bounded) and
   task 6 (the flip). Tasks 5, 7, 8 small enough to handle inline.
2. **Inline Execution** — one task at a time in this session.

Pick.
