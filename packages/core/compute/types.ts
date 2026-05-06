/**
 * Compute / Isolation split -- primary abstractions.
 *
 * Two-axis dispatch model (see `docs/architecture.md`):
 *
 *   - `Compute`        -- where the VM / container / host lives
 *   - `Isolation`      -- how the agent process is sandboxed inside that host
 *   - `ComputeTarget`  -- the composed (compute, isolation) pair used at dispatch
 *
 * "Isolation" was previously called "Runtime", but that collided with the
 * separate "agent runtime" concept (claude-code / codex / gemini / goose) one
 * layer up. Renamed for clarity: the layer-2 agent-runtime stays "runtime",
 * this layer-4b sandbox is "isolation".
 *
 * The legacy `ComputeProvider` interface stays live and unchanged -- the
 * adapter in `../adapters/legacy.ts` bridges the old world into the new until
 * every dispatch path reads from the new interfaces.
 */

// ── Kinds ──────────────────────────────────────────────────────────────────

/** Where the compute lives. */
export type ComputeKind = "local" | "firecracker" | "ec2" | "k8s" | "k8s-kata";

/** How the agent process is sandboxed inside the compute. */
export type IsolationKind = "direct" | "docker" | "compose" | "devcontainer" | "firecracker-in-container";

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
 *
 * Post-launch ops live on the handle so `ComputeTarget` covers the full
 * compute lifecycle. `getMetrics` is added as an optional method so legacy
 * handles (synthesized by `attachExistingHandle` on impls that haven't been
 * upgraded yet) keep working -- callers null-check before invoking.
 */
export interface ComputeHandle {
  readonly kind: ComputeKind;
  /** Stable identifier -- matches the `compute.name` PK in the DB. */
  readonly name: string;
  /** Backend-specific state (container id, EC2 instance id, VM socket, ...). */
  readonly meta: Record<string, unknown>;
  /**
   * Pull instantaneous resource metrics for this compute. Delegates to
   * arkd's `/snapshot` endpoint. Optional: handles synthesized outside of
   * `Compute.provision` / `attachExistingHandle` (eg. tests) may omit it.
   */
  getMetrics?(): Promise<ComputeSnapshot>;
}

/**
 * Handle returned by `Isolation.launchAgent`. For the direct / docker / ...
 * isolations this is just the tmux session name arkd launched, kept
 * structured so future isolations can attach extra state (compose project,
 * devcontainer id) without a breaking change.
 *
 * The post-launch operations (`kill`, `captureOutput`, `checkAlive`) live
 * on the handle: `Isolation.launchAgent` constructs an AgentHandle whose
 * methods are closures bound to the live `ArkdClient` and the agent's
 * sessionName. This keeps the call site short (`agent.kill()`) while the
 * isolation owns the wire format for talking to arkd.
 *
 * Rehydration: server handlers that only have a persisted `sessionName`
 * (e.g. `session.session_id` after a process restart) use
 * `Isolation.attachAgent(compute, computeHandle, sessionName)` to rebuild
 * an equivalent handle without re-launching.
 */
export interface AgentHandle {
  readonly sessionName: string;
  readonly meta?: Record<string, unknown>;
  /** Terminate the agent process. Idempotent -- arkd no-ops on missing tmux sessions. */
  kill(): Promise<void>;
  /** Capture the agent's tmux pane output. Returns the pane contents as a string. */
  captureOutput(opts?: { lines?: number }): Promise<string>;
  /** Whether the agent process is still alive. Returns false if arkd is unreachable. */
  checkAlive(): Promise<boolean>;
}

/**
 * Resource snapshot returned by `ComputeHandle.getMetrics`. Re-exported from
 * `packages/types/common.ts` -- this is the shape arkd's `/snapshot` endpoint
 * already returns and the dashboard already consumes, so we reuse it instead
 * of inventing a parallel ComputeMetrics shape.
 */
export type ComputeSnapshot = import("../../types/common.js").ComputeSnapshot;

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
  app: import("../app.js").AppContext;
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
  placement: import("../secrets/deferred-placement-ctx.js").DeferredPlacementCtx;
  sessionId: string;
  onLog?: (msg: string) => void;
}

/**
 * Compute-row shape used by `Compute.attachExistingHandle` to synthesize a
 * handle for an already-provisioned compute. Mirrors the relevant subset of
 * the `compute` table that the synthesizer needs -- name + status (to gate
 * "is this row alive?") and config (carries provider-specific meta like
 * `instance_id`, `region`, etc.).
 *
 * Kept narrow on purpose so kinds can drift independently without dragging
 * the full repo type. The full row lives in `packages/types/compute.ts`.
 */
export interface AttachExistingComputeRow {
  name: string;
  status: string;
  config: Record<string, unknown>;
}

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Thrown when a Compute impl is asked to do something its capabilities flag
 * says it cannot. The registry / dispatch layer should generally guard
 * capabilities before calling, but a runtime error beats silently dropping.
 */
export class NotSupportedError extends Error {
  constructor(
    public readonly computeKind: ComputeKind | IsolationKind,
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

  /**
   * Synthesize a `ComputeHandle` from a `compute` row that already
   * represents a provisioned instance. Returns null when the row hasn't
   * been provisioned yet -- in which case `provision()` must run first.
   *
   * The dispatcher calls this in `resolveTargetAndHandle` before falling
   * through to a fresh `provision()`. Persistent computes (LocalCompute,
   * EC2Compute against a running instance) build the handle straight from
   * `row.config` -- no AWS / k8s round-trip, no re-provisioning. Template
   * computes (per-session pod / microVM) leave it omitted (the dispatcher
   * defaults to `provision()` for those).
   *
   * Pure: must not perform I/O. Just maps `row.config` -> handle meta.
   */
  attachExistingHandle?(row: AttachExistingComputeRow): ComputeHandle | null;

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
   *   - EC2Compute: SSM connectivity check, AWS-StartPortForwardingSession
   *     to arkd, arkd /health probe, events-stream subscribe. Mutates
   *     `handle.meta.ec2.arkdLocalPort` so the next call to
   *     `getArkdUrl(h)` resolves to the new local-side port.
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
   *   - EC2Compute: flushes onto an `EC2PlacementCtx` that ships bytes
   *     via `ssm.SendCommand` (base64-decode on the remote, mode-
   *     preserving) and uses `sed -i` for marker-keyed appends.
   *   - K8sCompute: flushes onto a `K8sPlacementCtx` that uses
   *     `kubectl cp` for writes and `kubectl exec` for appends.
   *   - FirecrackerCompute: flushes onto a microVM-aware ctx (over
   *     guest ssh).
   *
   * Idempotent: appendFile is marker-keyed (sed-rewrite block); writeFile
   * overwrites by path. A second call with an empty queue is a no-op.
   *
   * Ordering invariant: `ensureReachable` MUST have run on this handle
   * before `flushPlacement` so the compute medium (SSM port-forward,
   * kubectl port-forward, microVM bridge) is live; some impls (e.g. EC2)
   * read transport fields from `handle.meta` that ensureReachable populates.
   */
  flushPlacement?(h: ComputeHandle, opts: FlushPlacementOpts): Promise<void>;

  /** Snapshot support. Throws `NotSupportedError` if `!capabilities.snapshot`. */
  snapshot(h: ComputeHandle): Promise<Snapshot>;
  restore(s: Snapshot): Promise<ComputeHandle>;
}

/**
 * Primary isolation abstraction. How the agent process is sandboxed inside
 * the compute. Stateless with respect to the compute -- isolations take a
 * `Compute` + `ComputeHandle` pair in every method so one isolation instance
 * can be reused across many computes.
 */
export interface Isolation {
  readonly kind: IsolationKind;
  readonly name: string;

  /** One-time setup inside a provisioned compute (install deps, bring up compose, etc.). */
  prepare(compute: Compute, h: ComputeHandle, ctx: PrepareCtx): Promise<void>;

  /** Launch the agent process via arkd (inside compute). */
  launchAgent(compute: Compute, h: ComputeHandle, opts: LaunchOpts): Promise<AgentHandle>;

  /**
   * Rehydrate an `AgentHandle` from a persisted sessionName without
   * re-launching the agent. Used by server handlers / status pollers /
   * terminate paths that only have a session id from the DB.
   *
   * The returned handle's methods are bound to the same arkd client the
   * isolation would build during `launchAgent`. Pure: no I/O at attach time.
   *
   * **Constraint:** isolations that hold per-session state on
   * `handle.meta.<isolation>` (docker, devcontainer) require that
   * `prepare()` ran in this process so the meta slot is populated. For
   * those isolations, calling `attachAgent` against a `ComputeHandle`
   * that was rehydrated via `Compute.attachExistingHandle` (i.e. without
   * a prior `prepare()` in this process) will succeed at attach time but
   * throw on the first `kill()`/`captureOutput()`/`checkAlive()` call.
   * Callers that need cross-process rehydrate should use
   * `LocalCompute + DirectIsolation` or persist the isolation meta
   * alongside the compute handle.
   */
  attachAgent(compute: Compute, h: ComputeHandle, sessionName: string): AgentHandle;

  /** Isolation-level teardown (compose down, devcontainer stop, etc.). */
  shutdown(compute: Compute, h: ComputeHandle): Promise<void>;
}
