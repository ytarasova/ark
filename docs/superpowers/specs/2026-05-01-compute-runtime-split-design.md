# Two-axis compute model: ComputeProvider × Runtime

**Status:** Design. Implementation in
`docs/superpowers/plans/2026-05-01-compute-runtime-split-plan.md`.

## Background

Ark's dispatcher today resolves a session to a single `ComputeProvider`
class that bakes together two orthogonal concerns:

1. **Where the hardware comes from** — a host machine, an EC2 instance
   reached via SSM, a Kubernetes pod, a Firecracker microVM.
2. **How the agent is isolated on that hardware** — bare process,
   docker container, docker-compose stack, devcontainer build,
   firecracker microVM nested on top of another host.

The combined model produced a class explosion:
`LocalWorktreeProvider`, `LocalDockerProvider`, `LocalDevcontainerProvider`,
`RemoteWorktreeProvider`, `RemoteDockerProvider`, `RemoteDevcontainerProvider`,
`FirecrackerProvider`, `K8sProvider`, `KataProvider`, ... -- one row in
the matrix per `(compute, runtime)` pair, each duplicating the other's
`provision` / `launch` / `cleanup` boilerplate.

It also leaked. `agent-launcher.ts` (`packages/core/services/`) ended
up importing from `compute/providers/ec2/*` because there was no clean
"runtime" object on which `applyContainerSetup` (compose-up,
devcontainer wrap) could live. Every time a new isolation flavour gets
proposed (Kata, gVisor, Firecracker-on-K8s) the existing class explosion
gets worse.

The two-axis model already exists in the schema (`compute_kind`,
`runtime_kind` columns; `packages/compute/adapters/provider-map.ts`)
but is not honoured at the implementation layer: the legacy provider
name is what the dispatcher actually resolves against.

## Goals

- Express the model in code the way the schema already expresses it:
  `(compute_kind, runtime_kind)` selects a `ComputeProvider` and a
  `Runtime` independently.
- `ComputeProvider` knows nothing about agents. Its surface is
  `provision` / `start` / `stop` / `destroy` + `prepareForLaunch`
  (transport readiness). Once arkd is reachable, the provider's job
  is done.
- `Runtime` knows nothing about hardware. Its surface is
  `prepareIsolation` (e.g. `docker compose up`), `wrapLaunchScript`
  (e.g. wrap the launcher in `docker exec`), and `cleanup`. Same
  runtime works on `local`, `ec2`, `k8s` -- it just emits different
  shell commands depending on what's available.
- The dispatcher composes the two by reading `(compute_kind, runtime_kind)`
  off the row and looking up the corresponding pair from the registry.
- Every per-session orchestration step (flush secrets, git clone,
  launch agent) flows through `ArkdClient` -- no provider-specific
  machinery for those.
- The full N×M matrix is reachable without one class per cell.

## Non-goals

- Replacing `ArkdClient` or the `/events/stream` pull architecture.
- Adding new isolation flavours (Kata, gVisor) in the same change. The
  abstraction must accept them later; we don't ship them now.
- Renaming the existing `compute_kind` / `runtime_kind` schema values
  or the `provider_map.ts` legacy translations -- back-compat with
  existing DB rows is required.

## Cardinality

### ComputeKind (where hardware comes from)

| kind          | Implementation                                            |
| ------------- | --------------------------------------------------------- |
| `local`       | The conductor's host. arkd runs co-located.               |
| `ec2`         | AWS EC2 instance reached via SSM (no public IP / port 22).|
| `k8s`         | Kubernetes pod (vanilla container runtime).               |
| `k8s-kata`    | Kubernetes pod with Kata isolation. Subclass of `k8s`.    |
| `firecracker` | Firecracker microVM as the primary compute target.        |

### RuntimeKind (how the agent is isolated)

| kind                       | Implementation                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `direct`                   | No isolation. Agent runs as the launcher process on the host.                                        |
| `docker`                   | Single container. Launcher invoked via `docker exec`.                                                |
| `docker-compose`           | `docker compose up -d` from `arc.json`; agent runs inside the named service container.               |
| `devcontainer`             | `devcontainer.json`-driven build; launcher wrapped via `devcontainer exec`.                          |
| `ark-compose`              | Ark's own declarative compose layer. Spec TBD; same Runtime surface, different config dialect.       |
| `firecracker-in-container` | Firecracker microVM booted inside a container on whatever compute you're on. Strong per-session VM. |

The schema already enumerates these; no new values added.

## Interfaces

### `ComputeProvider`

Provider's job ends when arkd is reachable. **No agent-specific code.**

```ts
interface ComputeProvider {
  readonly kind: ComputeKind;
  readonly canDelete: boolean;
  readonly canReboot: boolean;
  readonly singleton: boolean;
  readonly initialStatus: ComputeStatus;
  readonly needsAuth: boolean;

  // Lifecycle
  provision(compute: Compute, opts?: ProvisionOpts): Promise<void>;
  start(compute: Compute): Promise<void>;
  stop(compute: Compute): Promise<void>;
  destroy(compute: Compute): Promise<void>;
  reboot?(compute: Compute, opts?: RebootOpts): Promise<void>;

  // Transport readiness
  prepareForLaunch?(opts: PrepareForLaunchOpts): Promise<void>;
  getArkdUrl(compute: Compute): string;

  // Status reconciliation
  checkStatus?(compute: Compute): Promise<string | null>;

  // Provider-specific: where the cloned worktree lives on this host
  resolveWorkdir?(compute: Compute, session: Session): string | null;

  // Optional: run an arbitrary command on the host (used by some Runtime
  // impls that need to poke the host directly, e.g. ComposeRuntime's
  // `docker compose up`). Provider-specific because the transport is
  // medium-specific (SSH for EC2, kubectl exec for k8s, direct spawn
  // for local).
  runOnHost?(compute: Compute, cmd: string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;

  // Build a PlacementCtx for this compute's medium (SSH / k8s API / fs).
  buildPlacementCtx?(session: Session, compute: Compute): Promise<PlacementCtx>;
}
```

`prepareForLaunch` is the only hook that runs unconditionally per
dispatch. It emits `provisioning_step` events for each internal phase
(connectivity-check / forward-tunnel / arkd-probe / events-consumer-start
for EC2; pod-readiness / kubectl-port-forward / arkd-probe for k8s; no-op
for local).

### `Runtime`

Runtime's job is to wrap the launch script and manage isolation
lifecycle. **No hardware-specific code.**

```ts
interface Runtime {
  readonly kind: RuntimeKind;

  /**
   * Read isolation config from the worktree (arc.json's
   * `compose: true`, `devcontainer: true`, etc.) and decide whether
   * this runtime applies. Returns false for runtimes that aren't
   * activated for this session.
   */
  applies(workdir: string): boolean;

  /**
   * Bring isolation up: docker compose, devcontainer build, firecracker
   * boot. Idempotent; runs once before the agent is launched. Provider
   * is passed in so the runtime can poke the host via
   * `provider.runOnHost(...)` without knowing the medium.
   */
  prepareIsolation?(opts: PrepareIsolationOpts): Promise<void>;

  /**
   * Wrap the agent launch script in this runtime's invocation shell:
   *   - DirectRuntime: pass through unchanged
   *   - DockerRuntime: prepend `docker exec -it <container> ...`
   *   - ComposeRuntime: prepend `docker compose exec <service> ...`
   *   - DevcontainerRuntime: re-emit launcher inside `devcontainer exec`
   *   - FirecrackerRuntime: prepend `firectl exec` or microVM ssh
   *
   * Pure transformation. No I/O.
   */
  wrapLaunchScript(script: string, ctx: WrapCtx): string;

  /**
   * Tear down isolation after a session ends: `docker compose down`,
   * stop microVM, remove devcontainer. Best-effort; idempotent.
   */
  cleanup?(opts: CleanupIsolationOpts): Promise<void>;
}

interface PrepareIsolationOpts {
  app: AppContext;
  compute: Compute;
  session: Session;
  provider: ComputeProvider; // for runOnHost
  workdir: string;
  onLog: (msg: string) => void;
}

interface WrapCtx {
  compute: Compute;
  session: Session;
  workdir: string; // path the launcher should `cd` into
}
```

### Composition

```ts
// packages/core/services/agent-launcher.ts (provider-agnostic):
async function prepareEnvironment(app, session, compute, opts) {
  const provider = app.providers.get(compute.compute_kind);
  const runtime  = app.runtimes.get(compute.runtime_kind);

  if (compute.status === "stopped") {
    await provisionStep(app, session.id, "compute-start", () => provider.start(compute), { retries: 1 });
  }

  if (provider.prepareForLaunch) {
    await provider.prepareForLaunch({ app, compute, session, onLog: opts.onLog });
  }

  if (runtime.applies(opts.workdir) && runtime.prepareIsolation) {
    await provisionStep(app, session.id, "isolation-prepare", () =>
      runtime.prepareIsolation!({ app, compute, session, provider, workdir: opts.workdir, onLog: opts.onLog }),
    );
  }

  const wrapped = runtime.wrapLaunchScript(opts.launchScript, { compute, session, workdir: opts.workdir });
  return { launchScript: wrapped, ports: resolvePortDecls(opts.workdir) };
}
```

The dispatcher then hands `wrapped` to whatever launches the agent.
Today that's `provider.launch(...)`. In a follow-up phase, the
launch can move into a generic `runRemoteAgentSession(arkdClient,
session, opts)` that calls arkd's HTTP API directly -- but that's
out of scope for THIS spec; the surface above already supports it.

## Per-cell behaviour matrix

```
                local        ec2          k8s          firecracker
              +------------+------------+------------+------------+
direct        | bare proc  | ssh+arkd   | pod+arkd   | microVM    |
              | (no wrap)  | (no wrap)  | (no wrap)  | + ssh      |
              +------------+------------+------------+------------+
docker        | local      | docker on  | docker in  | docker in  |
              | sidecar    | EC2        | sidecar    | microVM    |
              +------------+------------+------------+------------+
docker-compose| compose +  | ssh+compose| (n/a usu.) | ?          |
              | docker exec|            |            |            |
              +------------+------------+------------+------------+
devcontainer  | devc CLI   | devc on EC2| (n/a usu.) | ?          |
              +------------+------------+------------+------------+
ark-compose   | TBD        | TBD        | TBD        | TBD        |
              +------------+------------+------------+------------+
firecracker-in| local      | EC2 +      | k8s pod +  | (redundant)|
container     | firecracker| firecracker| firecracker|            |
              +------------+------------+------------+------------+
```

Every cell uses the SAME `Runtime` impl on the right; only the
provider's `runOnHost` differs (direct spawn vs `ssh ... docker compose
up` vs `kubectl exec ... docker compose up`).

## Migration phases

### Phase 1: Runtime interface + Direct/Docker/Compose/Devcontainer impls

- Define `Runtime` interface in `packages/compute/runtimes/types.ts`.
- Implement `DirectRuntime` (no-op wrap, applies on every workdir).
- Implement `DockerRuntime` (existing local-arkd docker sidecar logic
  moves here).
- Implement `ComposeRuntime` (the `arc.json:compose:true` body of
  `applyContainerSetup` moves here).
- Implement `DevcontainerRuntime` (the `arc.json:devcontainer:true`
  branch moves here).
- Implement `FirecrackerRuntime` (existing firecracker-in-container
  body moves here).
- New `RuntimeRegistry` keyed by `RuntimeKind`.
- `agent-launcher.ts` consults the registry instead of inlining
  `applyContainerSetup`. Existing behaviour preserved.

### Phase 2: ComputeProvider surface tightening

- Add `runOnHost(compute, cmd[], opts)` to `ComputeProvider`.
  Implement on `LocalProvider` (direct spawn) and `RemoteArkdBase`
  (existing `sshExec` wrap). K8s gets `kubectl exec`.
- The Runtime impls drop their direct imports of `compute/providers/ec2/*`
  and use `provider.runOnHost(...)` instead.
- agent-launcher.ts has zero `compute/providers/*` imports.

### Phase 3: Split combined provider classes

- `LocalDockerProvider` becomes `LocalProvider × DockerRuntime`.
- `LocalDevcontainerProvider` becomes `LocalProvider × DevcontainerRuntime`.
- `RemoteDockerProvider` becomes `EC2Provider × DockerRuntime`.
- `RemoteDevcontainerProvider` becomes `EC2Provider × DevcontainerRuntime`.
- `FirecrackerProvider` becomes either `FirecrackerProvider × DirectRuntime`
  (microVM as compute) or `LocalProvider × FirecrackerRuntime` (microVM
  as isolation), determined by the row's `compute_kind`.
- `provider-map.ts` translation table preserved for back-compat with
  legacy DB rows; new rows write `compute_kind` + `runtime_kind`
  directly.

### Phase 4: Provider-agnostic session orchestrator

- New `runRemoteAgentSession(arkdClient, session, runtime, opts)` in
  `packages/core/services/`. Owns flush-secrets, git-clone,
  launch-agent. Calls `runtime.wrapLaunchScript(...)` once, hands the
  wrapped script to `arkdClient.launchAgent(...)`.
- `RemoteWorktreeProvider.launch` becomes a thin shim that calls the
  orchestrator. Same for k8s.
- `provider.launch(compute, session, opts)` could be deprecated
  entirely in favour of the orchestrator; left intact in this phase
  for back-compat with existing tests.

## Tests

Each Runtime gets a unit test file:

- `runtimes/__tests__/direct.test.ts` — `wrapLaunchScript` is identity.
- `runtimes/__tests__/docker.test.ts` — wrap prepends `docker exec`,
  `prepareIsolation` calls `runOnHost(["docker", "run", ...])`.
- `runtimes/__tests__/compose.test.ts` — `applies` reads `arc.json`,
  `prepareIsolation` calls `runOnHost(["docker", "compose", "up"])`.
- `runtimes/__tests__/devcontainer.test.ts` — wrap calls
  `buildLaunchCommand`.
- `runtimes/__tests__/firecracker.test.ts` — wrap goes through
  microVM ssh.

Each test stubs `ComputeProvider.runOnHost` and asserts on the calls,
no real Docker / ssh / firectl.

Integration:

- `agent-launcher.test.ts` (existing) — already runs; assert that the
  Runtime registry is consulted and the correct runtime fires.
- `e2e-dispatch-compute.test.ts` (existing) — asserts a full dispatch
  composes provider + runtime correctly for `(local, direct)`,
  `(local, docker)`, etc.

## Risks

- **Test surface for combined classes.** Tests today reach into
  `LocalDockerProvider.launch` etc. Phase 3 needs to keep those tests
  working OR migrate them to the new shape. We pick: keep the combined
  classes as thin shims that delegate to provider+runtime, so the test
  surface stays the same and the implementation moves underneath.
- **arc.json activation.** `applies(workdir)` reads `arc.json` to
  decide whether the runtime fires. Today the choice is implicit in
  which provider class the row resolved to. We expose it explicitly so
  an operator can override at the row level.
- **Per-cell n/a combinations.** Some `(compute, runtime)` pairs
  don't make sense (`docker-compose` inside a `k8s` pod is unusual).
  Provider+runtime composition validates this at registry-read time:
  the compose runtime asks the provider whether it has a docker
  daemon; if not, throws "compose runtime requires a docker daemon
  on the compute target".
- **Migration order.** Phase 1 ships a new abstraction WHILE the
  combined classes still exist; the runtime registry is consulted
  alongside the legacy `applyContainerSetup` path. Phase 3 deletes
  the duplication once Phase 1 has burned in.

## Success criteria

- agent-launcher.ts has zero imports from `compute/providers/*`.
- The full N×M cell matrix above is reachable by a one-line
  registry composition; no class explosion.
- A new isolation flavour (Kata, gVisor) ships as a single new
  `Runtime` impl + tests, no provider edits needed.
- All existing dispatch tests pass on the new composition path.

## Out of scope for this spec

- The `ark-compose` runtime's config dialect. Tracked separately.
- Multi-runtime composition (a session that wants compose + devcontainer
  + firecracker layered together). The interface already allows it via
  ordered runtime chains; this spec doesn't ship the chain composer.
- Replacing `ArkdClient.run` for git-clone / launch-agent with a more
  structured surface. Tracked in the issue #414 (terminal-attach
  unification).
