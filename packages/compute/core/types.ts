/**
 * Compute / Runtime split -- primary abstractions.
 *
 * See `.workflow/plan/compute-runtime-vision.md` (section "Core interfaces") for
 * the intended shape. Today's `ComputeProvider` interface in `../types.ts`
 * conflates two axes (where the VM/container lives, and how the agent runs);
 * the interfaces in this file pull them apart:
 *
 *   - `Compute`        -- where the VM / container / host lives
 *   - `Runtime`        -- how the agent process is launched inside that host
 *   - `ComputeTarget`  -- the composed (compute, runtime) pair used at dispatch
 *
 * The legacy `ComputeProvider` interface stays live and unchanged -- the
 * adapter in `../adapters/legacy.ts` bridges the old world into the new until
 * every dispatch path reads from the new interfaces.
 */

// ── Kinds ──────────────────────────────────────────────────────────────────

/** Where the compute lives. Mirrors the vision doc's target set. */
export type ComputeKind = "local" | "firecracker" | "ec2" | "k8s" | "k8s-kata";

/** How the agent process is launched inside the compute. */
export type RuntimeKind = "direct" | "docker" | "compose" | "devcontainer" | "firecracker-in-container";

/** Provision latency bucket, used for pool sizing decisions. */
export type ProvisionLatency = "instant" | "seconds" | "minutes";

// ── Capability descriptor ──────────────────────────────────────────────────

/**
 * Read-only capability flags for a Compute. Kept as a plain readonly object
 * (not a class) so it can be a static `const` on the impl and still be
 * introspected by the registry at boot time.
 */
export interface ComputeCapabilities {
  readonly snapshot: boolean;
  readonly pool: boolean;
  readonly networkIsolation: boolean;
  readonly provisionLatency: ProvisionLatency;
}

// ── Handles ────────────────────────────────────────────────────────────────

/**
 * Opaque handle produced by `Compute.provision`. Carries the compute name
 * (so repos can be updated by the conductor) plus compute-specific state in
 * `meta` (the same config bag today's `Compute.config` holds).
 */
export interface ComputeHandle {
  readonly kind: ComputeKind;
  /** Stable identifier -- matches the `compute.name` PK in the DB. */
  readonly name: string;
  /** Backend-specific state (container id, EC2 instance id, VM socket, ...). */
  readonly meta: Record<string, unknown>;
}

/**
 * Handle returned by `Runtime.launchAgent`. For the direct / docker / ...
 * runtimes this is just the tmux session name arkd launched, kept
 * structured so future runtimes can attach extra state (compose project,
 * devcontainer id) without a breaking change.
 */
export interface AgentHandle {
  readonly sessionName: string;
  readonly meta?: Record<string, unknown>;
}

// ── Options passed through the lifecycle ───────────────────────────────────

export interface ProvisionOpts {
  /** AWS instance size / k8s node class / firecracker memory tier. */
  size?: string;
  arch?: string;
  tags?: Record<string, string>;
  /** Optional backend-specific payload (eg. container image, devcontainer path). */
  config?: Record<string, unknown>;
  onLog?: (msg: string) => void;
}

/** One-time runtime setup inside a provisioned compute. */
export interface PrepareCtx {
  /** Absolute path on the compute where the workdir lives. */
  workdir: string;
  /** Arbitrary per-session config (compose file name, devcontainer overrides). */
  config?: Record<string, unknown>;
  onLog?: (msg: string) => void;
}

export interface LaunchOpts {
  /** Tmux session name. Arkd uses this to identify the agent. */
  tmuxName: string;
  /** Workdir on the compute. */
  workdir: string;
  /** The launcher shell script body that arkd will execute. */
  launcherContent: string;
  /** Declared ports the agent plans to expose. */
  ports?: Array<{ port: number; name?: string; source?: string }>;
  /** Extra env vars the runtime should inject before invoking the launcher. */
  env?: Record<string, string>;
}

/**
 * Options threaded into `Compute.ensureReachable`. The implementation
 * needs `app` to emit `provisioning_step` events on the session timeline
 * (via `provisionStep` from `core/services/provisioning-steps.ts`), and
 * `sessionId` so those events land on the right session. `onLog` mirrors
 * the human-facing log line the dispatcher already streams to the UI.
 */
export interface EnsureReachableOpts {
  app: import("../../core/app.js").AppContext;
  sessionId: string;
  onLog?: (msg: string) => void;
}

/**
 * Options threaded into `Compute.prepareWorkspace`. Both `source` and
 * `remoteWorkdir` are nullable: callers pass through the resolved
 * values from `session.config.remoteRepo`/`session.repo` and
 * `Compute.resolveWorkdir` respectively, and either can be unset on a
 * bare-worktree dispatch.
 */
export interface PrepareWorkspaceOpts {
  /** Source URL or path to clone. Typically `session.config.remoteRepo` or `session.repo`. */
  source: string | null;
  /** Resolved remote workdir from `Compute.resolveWorkdir`. Null on local. */
  remoteWorkdir: string | null;
  sessionId: string;
  onLog?: (msg: string) => void;
}

/**
 * Options threaded into `Compute.flushPlacement`. Carries the deferred
 * placement context the dispatcher accumulated during `buildLaunchEnv`,
 * the session id (for log correlation), and an optional log sink.
 */
export interface FlushPlacementOpts {
  /**
   * The deferred placement context the dispatcher accumulated during
   * `buildLaunchEnv`. Carries queued writeFile / appendFile / setEnv
   * ops the runtime needs delivered onto the compute's medium before
   * the agent launches (SSH-private-key files, ssh config blocks,
   * known_hosts entries, ...).
   */
  placement: import("../../core/secrets/deferred-placement-ctx.js").DeferredPlacementCtx;
  sessionId: string;
  onLog?: (msg: string) => void;
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when a Compute impl is asked to do something its capabilities flag
 * says it cannot. The registry / dispatch layer should generally guard
 * capabilities before calling, but a runtime error beats silently dropping.
 */
export class NotSupportedError extends Error {
  constructor(
    public readonly computeKind: ComputeKind | RuntimeKind,
    public readonly op: string,
  ) {
    super(`${computeKind} does not support ${op}`);
    this.name = "NotSupportedError";
  }
}

// ── Snapshot ───────────────────────────────────────────────────────────────

export interface Snapshot {
  id: string;
  computeKind: ComputeKind;
  createdAt: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

// ── Core interfaces ────────────────────────────────────────────────────────

/**
 * Primary compute abstraction. Where the VM / container / host lives.
 *
 * Lifecycle: `provision` is the only method that can mint a new handle.
 * Everything else takes a handle previously returned by `provision` (or
 * `restore`). Throw `NotSupportedError` from `snapshot` / `restore` if
 * `capabilities.snapshot === false`.
 */
export interface Compute {
  readonly kind: ComputeKind;
  readonly capabilities: ComputeCapabilities;

  provision(opts: ProvisionOpts): Promise<ComputeHandle>;
  start(h: ComputeHandle): Promise<void>;
  stop(h: ComputeHandle): Promise<void>;
  destroy(h: ComputeHandle): Promise<void>;

  /** Where arkd listens. URL reachable from the ark host conductor. */
  getArkdUrl(h: ComputeHandle): string;

  /**
   * Translate a conductor-side workdir path to the path the compute
   * exposes for the agent's `cd` and tmux `-c`. Pure transform; no I/O.
   *
   *   - LocalCompute: returns null (caller falls back to session.workdir
   *     since conductor and compute share a filesystem).
   *   - EC2Compute: returns `${remoteHome}/Projects/<sid>/<repo>`.
   *   - K8sCompute: returns `/workspace/<sid>/<repo>` (or whatever the
   *     pod's mount layout dictates).
   *   - FirecrackerCompute: same shape as EC2 inside the microVM.
   *
   * Optional: impls that share the conductor's filesystem layout omit.
   * Callers that get null fall back to `session.workdir` / the conductor-
   * side path.
   */
  resolveWorkdir?(h: ComputeHandle, session: import("../../types/session.js").Session): string | null;

  /**
   * Make the compute reachable from the conductor. Idempotent. Called
   * on every dispatch (fresh provision AND rehydrated handle).
   *
   * Provider-specific behaviour:
   *   - LocalCompute: no-op (arkd is on the same host as the conductor).
   *   - EC2Compute: SSH-over-SSM connectivity check, forward `-L`
   *     tunnel, arkd /health probe, events-stream subscribe. Mutates
   *     `handle.meta.ec2.arkdLocalPort` so the next call to
   *     `getArkdUrl(h)` resolves to the new tunnel.
   *   - K8sCompute: kubectl port-forward, arkd /health probe.
   *   - FirecrackerCompute: TAP bridge wiring, microVM ssh probe.
   *
   * Implementations should emit `provisioning_step` events for their
   * internal phases via `provisionStep`.
   *
   * Optional: omit on impls that need no transport setup.
   */
  ensureReachable?(h: ComputeHandle, opts: EnsureReachableOpts): Promise<void>;

  /**
   * Set up the per-session workspace on the compute. Idempotent on the
   * leaf path (the dispatcher's resolveWorkdir embeds the session id so
   * the leaf is fresh per dispatch; the parent mkdir is idempotent).
   *
   *   - LocalCompute: omits (the worktree is already on the host;
   *     conductor and compute share a filesystem).
   *   - EC2Compute / K8sCompute / FirecrackerCompute: mkdir + git clone
   *     via arkd HTTP using the URL from `getArkdUrl(handle)`.
   *
   * Returns silently when `source` or `remoteWorkdir` is null (no work
   * to do; caller is bare-worktree mode).
   *
   * Ordering invariant: `ensureReachable` MUST have run on this handle
   * before `prepareWorkspace` so `getArkdUrl(handle)` resolves to a
   * live transport. The dispatcher's `runTargetLifecycle` enforces
   * this; ad-hoc callers must do the same.
   */
  prepareWorkspace?(h: ComputeHandle, opts: PrepareWorkspaceOpts): Promise<void>;

  /**
   * Replay queued typed-secret placement ops onto the compute's medium.
   *
   *   - LocalCompute: flushes onto a `LocalPlacementCtx` that writes
   *     files directly via `fs.promises.writeFile`.
   *   - EC2Compute: flushes onto an `EC2PlacementCtx` that pipes
   *     `tar c | ssh tar x` to deliver bytes (mode-preserving) and
   *     `sed -i` for marker-keyed appends.
   *   - K8sCompute: flushes onto a `K8sPlacementCtx` that uses
   *     `kubectl cp` for writes and `kubectl exec` for appends.
   *   - FirecrackerCompute: flushes onto a microVM-aware ctx (over
   *     guest ssh).
   *
   * Idempotent: appendFile is marker-keyed (sed-rewrite block); writeFile
   * overwrites by path. A second call with an empty queue is a no-op.
   *
   * Ordering invariant: `ensureReachable` MUST have run on this handle
   * before `flushPlacement` so the compute medium (SSH tunnel, kubectl
   * port-forward, microVM bridge) is live; some impls (e.g. EC2) read
   * transport fields from `handle.meta` that ensureReachable populates.
   */
  flushPlacement?(h: ComputeHandle, opts: FlushPlacementOpts): Promise<void>;

  /** Snapshot support. Throws `NotSupportedError` if `!capabilities.snapshot`. */
  snapshot(h: ComputeHandle): Promise<Snapshot>;
  restore(s: Snapshot): Promise<ComputeHandle>;
}

/**
 * Primary runtime abstraction. How the agent process is launched inside the
 * compute. Stateless with respect to the compute -- runtimes take a `Compute`
 * + `ComputeHandle` pair in every method so one runtime instance can be
 * reused across many computes.
 */
export interface Runtime {
  readonly kind: RuntimeKind;
  readonly name: string;

  /** One-time setup inside a provisioned compute (install deps, bring up compose, etc.). */
  prepare(compute: Compute, h: ComputeHandle, ctx: PrepareCtx): Promise<void>;

  /** Launch the agent process via arkd (inside compute). */
  launchAgent(compute: Compute, h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle>;

  /** Runtime-level teardown (compose down, devcontainer stop, etc.). */
  shutdown(compute: Compute, h: ComputeHandle): Promise<void>;
}
