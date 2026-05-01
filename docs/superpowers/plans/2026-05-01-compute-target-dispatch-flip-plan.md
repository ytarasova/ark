# Flip dispatch to `ComputeTarget` — Implementation Plan

> **Supersedes:** `docs/superpowers/plans/2026-05-01-compute-runtime-split-plan.md`.
> That earlier plan duplicated existing work. The two-axis abstraction
> (`Compute`, `Runtime`, `ComputeTarget`) already lives at
> `packages/compute/core/`. The actual missing piece is **dispatch
> still uses the legacy `ComputeProvider.launch` path instead of the
> `ComputeTarget` composition.** This plan flips it.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Make `dispatch-core` and the executors (`claude-code`,
`agent-sdk`) consume `ComputeTarget` (composition of `Compute` ×
`Runtime`) instead of the legacy `ComputeProvider`. Drop
`applyContainerSetup` and `provider.prepareForLaunch` (interim hooks)
once `target.prepare()` covers their responsibilities. Keep the
legacy adapter (`compute/adapters/legacy.ts`) live for now so
existing tests that construct legacy providers directly keep working.

**Architecture context:** see
`docs/superpowers/specs/2026-05-01-compute-runtime-split-design.md`
for the architectural model. The existing `Runtime` shape (`prepare`
/ `launchAgent` / `shutdown`) cleanly subsumes what the spec called
`prepareIsolation` + `wrapLaunchScript` + per-session orchestrator.

**Tech stack:** TypeScript, Bun. Touches:

- `packages/core/services/dispatch/dispatch-core.ts`
- `packages/core/services/dispatch/launch.ts`
- `packages/core/services/agent-launcher.ts` (drop)
- `packages/core/executors/claude-code.ts`
- `packages/core/executors/agent-sdk.ts`
- `packages/core/services/session/terminate.ts` (already uses target;
  audit for completeness)

**Out of scope:**
- Adding new `Compute` or `Runtime` impls (Kata, gVisor).
- Removing the legacy `ComputeProvider.launch` method or the
  `compute/providers/local-arkd.ts` / `remote-arkd.ts` classes (those
  stay live as legacy shims; they self-delete in a follow-up once
  every dispatch tests run on ComputeTarget).
- The `ark-compose` runtime config dialect.
- Replacing `provisionStep` -- it stays as the timing/retry wrapper
  around the new `target.*` calls.

---

### Task 1: Map current dispatch-core calls to their ComputeTarget equivalents

This task is documentation-only; produces an inline call-chart that
the rest of the tasks reference. Saves searching at every step.

- [ ] **Step 1: Read the live dispatch path and write the call chart**

Read `packages/core/services/dispatch/dispatch-core.ts:dispatch` and
note every `provider.*` call. Append the result as a comment block at
the top of `packages/core/services/dispatch/dispatch-core.ts` titled
`/* ── ComputeTarget migration call chart ── ... */`.

The chart maps:

| Today (legacy `provider`)        | After flip (`target`)              | Notes |
| -------------------------------- | ---------------------------------- | --- |
| `provider.start(compute)`        | `target.compute.start(handle)`     | If `handle` not yet held, provision first |
| `provider.prepareForLaunch(...)` | `target.prepare(handle, ctx)`      | Drop the interim hook |
| `applyContainerSetup(...)`       | covered by `target.prepare`        | Compose-up + devcontainer build moves into runtime |
| `provider.launch(c, s, opts)`    | `target.launchAgent(handle, opts)` | Returns `AgentHandle` not `string` |
| `provider.killAgent(c, s)`       | TBD -- arkd-side via `client.kill` | Already provider-agnostic in arkd |
| `provider.cleanupSession(c, s)`  | `target.shutdown(handle)`          | Runtime-level teardown |
| `provider.captureOutput(c, s)`   | TBD -- arkd `/agent/capture`       | Already arkd-side |
| `provider.buildPlacementCtx(...)`| Provider-still-owns                | Lives on `ComputeProvider`; move to `Runtime.prepare` later (separate phase) |
| `provider.getArkdUrl(c)`         | `target.getArkdUrl(handle)`        | Provider's old getter took `compute`; new takes handle |

- [ ] **Step 2: Commit the chart**

```bash
git add packages/core/services/dispatch/dispatch-core.ts
git commit -m "docs(dispatch): add ComputeTarget migration call chart"
```

This commit is documentation only. Subsequent tasks reference the
chart as the source of truth.

---

### Task 2: Add `app.dispatch.resolveTarget(session)` and a session-scoped handle cache

The dispatcher needs both:

1. The `ComputeTarget` for routing.
2. A `ComputeHandle` to thread through `target.prepare/launchAgent/shutdown`.

Today the legacy path has neither — it just passes the `Compute` row.
We persist the handle on `session.config.compute_handle` so a
crashed-conductor restart can resume against the same provisioned
compute (the handle holds the EC2 instance id, k8s pod name, etc.).

**Files:**

- Create: `packages/core/services/dispatch/target-resolver.ts`
- Test: `packages/core/services/dispatch/__tests__/target-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/services/dispatch/__tests__/target-resolver.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../../../app.js";
import { resolveTargetAndHandle } from "../target-resolver.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => app?.shutdown());

describe("resolveTargetAndHandle", () => {
  test("returns null target when session has no compute", async () => {
    const s = await app.sessions.create({ summary: "no-compute" });
    const r = await resolveTargetAndHandle(app, s);
    expect(r.target).toBeNull();
  });

  test("provisions a fresh handle when session.config.compute_handle is missing", async () => {
    // Test profile uses LocalCompute which always provisions instantly.
    const s = await app.sessions.create({ summary: "local", compute_name: "local" });
    const r = await resolveTargetAndHandle(app, s);
    expect(r.target).not.toBeNull();
    expect(r.handle?.kind).toBe("local");
    // Handle persisted for next dispatch.
    const refetched = (await app.sessions.get(s.id))!;
    expect((refetched.config as any).compute_handle).toBeDefined();
  });

  test("rehydrates handle when session.config.compute_handle is present", async () => {
    const s = await app.sessions.create({ summary: "rehydrate", compute_name: "local" });
    await app.sessions.update(s.id, {
      config: {
        ...(s.config as any),
        compute_handle: { kind: "local", name: "local", meta: { hostname: "test" } },
      },
    });
    const r = await resolveTargetAndHandle(app, (await app.sessions.get(s.id))!);
    expect(r.handle?.meta.hostname).toBe("test");
  });
});
```

- [ ] **Step 2: Run + verify FAIL**

Run: `make test-file F=packages/core/services/dispatch/__tests__/target-resolver.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

```ts
// packages/core/services/dispatch/target-resolver.ts
import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/index.js";
import type { ComputeHandle } from "../../../compute/core/types.js";
import type { ComputeTarget } from "../../../compute/core/compute-target.js";
import { logInfo } from "../../observability/structured-log.js";

/**
 * Resolve `(target, handle)` for a session ready to dispatch.
 *
 *   - When `session.config.compute_handle` exists, rehydrate it
 *     (resume after conductor restart, second-stage dispatch on same
 *     compute).
 *   - Otherwise provision a fresh handle through `target.provision`
 *     (which consults the pool registry when the Compute supports it)
 *     and persist the handle on `session.config.compute_handle`.
 *
 * Returns `{target: null}` when the session has no compute_name --
 * the caller should fall through to legacy provider lookup OR refuse
 * the dispatch.
 */
export async function resolveTargetAndHandle(
  app: AppContext,
  session: Session,
): Promise<{ target: ComputeTarget | null; handle: ComputeHandle | null }> {
  const { target } = await app.resolveComputeTarget(session);
  if (!target) return { target: null, handle: null };

  const persisted = (session.config as { compute_handle?: ComputeHandle } | null | undefined)?.compute_handle;
  if (persisted) {
    return { target, handle: persisted };
  }

  // First dispatch: provision through the target so the pool / direct
  // provision paths are honoured uniformly.
  const handle = await target.provision({ size: undefined });
  await app.sessions.update(session.id, {
    config: { ...(session.config ?? {}), compute_handle: handle },
  });
  logInfo("dispatch", `provisioned new handle for session ${session.id} (${handle.kind}/${handle.name})`, {
    sessionId: session.id,
    computeKind: handle.kind,
    computeName: handle.name,
  });
  return { target, handle };
}
```

- [ ] **Step 4: Run + verify PASS**

Run: `make test-file F=packages/core/services/dispatch/__tests__/target-resolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/services/dispatch/target-resolver.ts packages/core/services/dispatch/__tests__/target-resolver.test.ts
git commit -m "feat(dispatch): resolveTargetAndHandle (compute_handle rehydrate / fresh provision)"
```

---

### Task 3: Wrap `target.prepare` and `target.launchAgent` in `provisionStep`

Each one of the lifecycle calls becomes a structured step on the
session's timeline. Reuses the existing `provisionStep` helper from
`packages/core/services/provisioning-steps.ts`.

**Files:**

- Create: `packages/core/services/dispatch/target-lifecycle.ts`
- Test: `packages/core/services/dispatch/__tests__/target-lifecycle.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/services/dispatch/__tests__/target-lifecycle.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AppContext } from "../../../app.js";
import { runTargetLifecycle } from "../target-lifecycle.js";
import type { ComputeTarget } from "../../../compute/core/compute-target.js";

let app: AppContext;
beforeAll(async () => {
  app = await AppContext.forTestAsync();
  await app.boot();
});
afterAll(async () => app?.shutdown());

describe("runTargetLifecycle", () => {
  test("emits provisioning_step events for each lifecycle phase", async () => {
    const s = await app.sessions.create({ summary: "lifecycle" });
    let prepareCalls = 0;
    let launchCalls = 0;
    const fakeTarget = {
      prepare: async () => { prepareCalls++; },
      launchAgent: async () => { launchCalls++; return { sessionName: "ark-test" }; },
    } as unknown as ComputeTarget;

    const result = await runTargetLifecycle(app, s.id, fakeTarget, {
      kind: "local",
      name: "local",
      meta: {},
    } as any, {
      tmuxName: "ark-test",
      workdir: "/tmp/x",
      launcherContent: "echo hi",
    });

    expect(prepareCalls).toBe(1);
    expect(launchCalls).toBe(1);
    expect(result.sessionName).toBe("ark-test");

    const events = await app.events.list(s.id);
    const steps = events.filter((e: any) => e.type === "provisioning_step").map((e: any) => e.data);
    const okSteps = steps.filter((s: any) => s.status === "ok").map((s: any) => s.step);
    expect(okSteps).toContain("runtime-prepare");
    expect(okSteps).toContain("launch-agent");
  });
});
```

- [ ] **Step 2: Run + verify FAIL**

Run: `make test-file F=packages/core/services/dispatch/__tests__/target-lifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// packages/core/services/dispatch/target-lifecycle.ts
import type { AppContext } from "../../app.js";
import type { ComputeHandle, AgentHandle, LaunchOpts, PrepareCtx } from "../../../compute/core/types.js";
import type { ComputeTarget } from "../../../compute/core/compute-target.js";
import { provisionStep } from "../provisioning-steps.js";

/**
 * Run the prepare → launchAgent half of a ComputeTarget's lifecycle
 * inside structured `provisioning_step` events. The dispatch path
 * calls this once per session; provisioning of the handle itself
 * already happens in `resolveTargetAndHandle`.
 */
export async function runTargetLifecycle(
  app: AppContext,
  sessionId: string,
  target: ComputeTarget,
  handle: ComputeHandle,
  launchOpts: LaunchOpts,
  prepareCtx?: Partial<PrepareCtx>,
): Promise<AgentHandle> {
  const ctx: PrepareCtx = {
    workdir: prepareCtx?.workdir ?? launchOpts.workdir,
    config: prepareCtx?.config,
    onLog: prepareCtx?.onLog,
  };
  const stepCtx = { compute: handle.name, computeKind: handle.kind };

  await provisionStep(app, sessionId, "runtime-prepare", () => target.prepare(handle, ctx), {
    retries: 1,
    retryBackoffMs: 1_000,
    context: stepCtx,
  });

  return provisionStep(app, sessionId, "launch-agent", () => target.launchAgent(handle, launchOpts), {
    context: { ...stepCtx, tmuxName: launchOpts.tmuxName },
  });
}
```

- [ ] **Step 4: Run + verify PASS**

Run: `make test-file F=packages/core/services/dispatch/__tests__/target-lifecycle.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/core/services/dispatch/target-lifecycle.ts packages/core/services/dispatch/__tests__/target-lifecycle.test.ts
git commit -m "feat(dispatch): runTargetLifecycle wraps prepare+launchAgent in provisionStep"
```

---

### Task 4: Switch `claude-code` executor to ComputeTarget

The claude-code executor currently calls `prepareRemoteEnvironment(...)`
+ `provider.launch(...)`. Replace with `resolveTargetAndHandle(...)` +
`runTargetLifecycle(...)`.

**Files:**

- Modify: `packages/core/executors/claude-code.ts`

- [ ] **Step 1: Read the existing call sites**

```bash
grep -n "prepareRemoteEnvironment\|provider\.launch\|provider\.start" packages/core/executors/claude-code.ts
```

Three call sites today:

1. `prepareRemoteEnvironment(app, session, compute, provider, ...)` —
   transport setup + container wrap + ports resolve.
2. `provider.launch(compute, session, opts)` — actual agent launch.

- [ ] **Step 2: Replace the call sites**

Locate the block (around line 250) that conditionally calls
`prepareRemoteEnvironment` for remote computes:

```ts
if (compute && provider && !provider.supportsWorktree) {
  const { prepareRemoteEnvironment } = await import("../services/agent-launcher.js");
  const { finalLaunchContent, ports } = await prepareRemoteEnvironment(...);
  // ...
  const result = await provider.launch(compute, session, {...});
}
```

Replace with:

```ts
if (compute && provider && !provider.supportsWorktree) {
  const { resolveTargetAndHandle } = await import("../services/dispatch/target-resolver.js");
  const { runTargetLifecycle } = await import("../services/dispatch/target-lifecycle.js");
  const { resolvePortDecls } = await import("../../compute/arc-json.js");

  const { target, handle } = await resolveTargetAndHandle(app, session);
  if (!target || !handle) {
    return { ok: false, handle: "", message: "no compute target resolved for remote dispatch" };
  }

  const ports = effectiveWorkdir ? resolvePortDecls(effectiveWorkdir) : [];
  if (ports.length > 0) {
    await app.sessions.update(session.id, { config: { ...session.config, ports } });
  }

  const agentHandle = await runTargetLifecycle(
    app,
    session.id,
    target,
    handle,
    {
      tmuxName,
      workdir: launcherWorkdir,
      launcherContent: launchContent,
      ports,
    },
    { workdir: launcherWorkdir, onLog: log },
  );

  return { ok: true, handle: agentHandle.sessionName };
}
```

- [ ] **Step 3: Run the executor's adjacent tests**

Run: `make test-file F=packages/core/executors/__tests__/claude-code.test.ts`
Expected: PASS (existing).

Run: `make test-file F=packages/core/__tests__/agent-launcher.test.ts`
Expected: PASS (or update the test to point at the new resolver/lifecycle if it directly tested `prepareRemoteEnvironment`).

- [ ] **Step 4: Run the dispatch suites**

Run: `make test-file F=packages/core/__tests__/e2e-dispatch-compute.test.ts`
Expected: PASS.

Run: `make test-file F=packages/core/__tests__/e2e-session-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/executors/claude-code.ts
git commit -m "feat(dispatch): claude-code executor consumes ComputeTarget"
```

---

### Task 5: Switch `agent-sdk` executor to ComputeTarget

Same change as Task 4 but for the agent-sdk executor. Repeat the
replacement pattern; the call shape is identical.

**Files:**

- Modify: `packages/core/executors/agent-sdk.ts`

- [ ] **Step 1: Locate call sites**

```bash
grep -n "prepareRemoteEnvironment\|provider\.launch" packages/core/executors/agent-sdk.ts
```

- [ ] **Step 2: Apply the same replacement as Task 4**

- [ ] **Step 3: Run agent-sdk tests**

Run: `make test-file F=packages/core/__tests__/agent-sdk-dispatch.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/core/executors/agent-sdk.ts
git commit -m "feat(dispatch): agent-sdk executor consumes ComputeTarget"
```

---

### Task 6: Retire `applyContainerSetup` and `provider.prepareForLaunch`

These two interim hooks (added in commit `dd182cd9`) duplicate
responsibilities `target.prepare` already covers. With Tasks 4 + 5 in
place, `prepareRemoteEnvironment` no longer has callers from the
executor path; we delete it.

**Files:**

- Modify: `packages/core/services/agent-launcher.ts` (delete the file
  OR leave a thin shim that re-exports nothing -- prefer delete)
- Modify: `packages/compute/types.ts` (remove `prepareForLaunch?` from
  `ComputeProvider`)
- Modify: `packages/compute/providers/remote-arkd.ts` (remove the
  `prepareForLaunch` method, keep `probeArkdReady` if EC2Compute reads
  it during its own provision)
- Modify: `packages/core/__tests__/ssh-escape.test.ts` (the regression
  guard moves onto `compute/runtimes/docker-compose.ts`)

- [ ] **Step 1: Verify no remaining callers**

```bash
grep -rn "prepareRemoteEnvironment\|prepareForLaunch" packages/ --include="*.ts" 2>/dev/null
```

Expected: zero matches in non-test files. If a caller remains, it
needs to migrate to `runTargetLifecycle` first.

- [ ] **Step 2: Delete agent-launcher.ts**

```bash
git rm packages/core/services/agent-launcher.ts
```

- [ ] **Step 3: Remove `prepareForLaunch?` from ComputeProvider interface and RemoteArkdBase**

```ts
// In packages/compute/types.ts -- delete the prepareForLaunch? block
// In packages/compute/providers/remote-arkd.ts -- delete the
//   prepareForLaunch method body. Keep `probeArkdReady` private only
//   if EC2Compute.provision still calls it; otherwise delete that too.
```

- [ ] **Step 4: Move the ssh-escape regression guard onto docker-compose.ts**

```ts
// In packages/core/__tests__/ssh-escape.test.ts, replace the
// `agent-launcher.ts shell-escapes the workdir before cd` test with:
test("docker-compose runtime uses argv-form runOnHost (no shell interp)", () => {
  const src = readFileSync(join(ROOT, "packages/compute/runtimes/docker-compose.ts"), "utf-8");
  // Argv-form Bun.spawn / sshExecArgs, never `sh -c "<interpolated>"`.
  expect(src).not.toMatch(/sh\s+-c\s+`[^`]*\$\{/);
});
```

- [ ] **Step 5: Run lint + the affected tests**

```bash
make lint
make test-file F=packages/core/__tests__/ssh-escape.test.ts
make test-file F=packages/core/__tests__/agent-launcher.test.ts || echo "delete this stale test if it only exercised the deleted module"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(dispatch): retire agent-launcher.ts + prepareForLaunch shim (covered by ComputeTarget)"
```

---

### Task 7: Audit and update tests

Tests that constructed legacy `ComputeProvider` instances directly
keep working through the legacy adapter. Tests that asserted on the
*shape* of `prepareRemoteEnvironment`'s output need to migrate to
asserting on `provisioning_step` events from `runTargetLifecycle`.

**Files:**

- Audit: `packages/core/__tests__/*.test.ts` — search for direct
  imports of `prepareRemoteEnvironment`.
- Audit: `packages/core/services/__tests__/*.test.ts`.

- [ ] **Step 1: Find dependent tests**

```bash
grep -rln "prepareRemoteEnvironment" packages/ --include="*.ts" 2>/dev/null
```

- [ ] **Step 2: For each, either**

  a. Delete the test if it was a unit test of the deleted helper.
  b. Rewrite to assert on the equivalent `provisioning_step` events
     from `runTargetLifecycle`.

- [ ] **Step 3: Run the full suite**

Run: `make test`
Expected: zero new failures vs the baseline established at the
end of the bulletproof-provisioner work (5342 pass / 0 fail).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: migrate prepareRemoteEnvironment-shaped tests onto runTargetLifecycle / provisioning_step events"
```

---

### Task 8: Self-review + integration check

- [ ] **Step 1: Verify no legacy `provider.launch` callers remain in the dispatch path**

```bash
grep -rn "provider\.launch\b" packages/core/services/ packages/core/executors/ --include="*.ts" 2>/dev/null
```

Expected: zero matches in non-test files.

- [ ] **Step 2: Verify ComputeTarget is the consumer**

```bash
grep -rln "resolveComputeTarget\|runTargetLifecycle\|target\.launchAgent" packages/core/services/dispatch/ packages/core/executors/ 2>/dev/null
```

Expected: at least one match in `claude-code.ts`, `agent-sdk.ts`, and
`dispatch-core.ts`.

- [ ] **Step 3: Verify legacy adapter still works for back-compat**

Run: `make test-file F=packages/compute/__tests__/legacy-adapter.test.ts`
Expected: PASS.

- [ ] **Step 4: Live EC2 dispatch smoke**

Manually:

```bash
./ark server daemon stop && ./ark server daemon start
./ark session start \
  --remote-repo "git@bitbucket.org:paytmteam/pi-event-registry.git" \
  --compute ec2-ssm \
  --flow quick \
  --summary "ComputeTarget flip smoke test"
```

Watch for `provisioning_step` events `compute-provision`,
`runtime-prepare`, `launch-agent` to land on the timeline. The
existing `connectivity-check`, `forward-tunnel`, `arkd-probe`,
`events-consumer-start` events should now be emitted from inside
`EC2Compute.provision` (Compute layer) rather than the agent-launcher.

- [ ] **Step 5: Commit any cleanup**

```bash
git status
git commit -am "chore(dispatch): post-flip cleanup"
```

---

## Execution Handoff

Plan saved. Two execution options:

1. **Subagent-Driven** — fresh subagent per task with two-stage review.
2. **Inline Execution** — execute tasks in this session via
   `executing-plans`.

## Self-review (this plan, before execution)

- **Spec coverage**: every requirement in
  `docs/superpowers/specs/2026-05-01-compute-runtime-split-design.md`'s
  "Composition" + "Migration phase 4" sections maps to a task above.
- **Smaller scope than the superseded plan**: this plan does NOT add
  new Runtime impls (already exist). It does NOT touch the legacy
  `ComputeProvider` classes (the legacy adapter handles them). It
  ONLY flips the dispatch path from provider-direct calls to
  `ComputeTarget.*`.
- **Test surface preserved**: legacy adapter ensures direct-construction
  tests keep passing. Dispatch-shape tests that asserted on
  `prepareRemoteEnvironment`'s output get migrated to
  `provisioning_step` events.
- **Migration safety**: tasks 2 + 3 add NEW helpers without touching
  callers. Tasks 4 + 5 replace executor call sites. Task 6 deletes
  the now-unused interim hooks. Each task is independently
  revertable.
