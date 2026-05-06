/**
 * Run a `ComputeTarget`'s full per-dispatch lifecycle inside structured
 * `provisioning_step` events.
 *
 * The dispatcher's job after `resolveTargetAndHandle` returned a
 * `(target, handle)` pair is to walk the per-dispatch lifecycle in
 * order. Each step is optional -- impls that don't need it omit the
 * method, and the helper skips it cleanly:
 *
 *   1. `compute-start`      -- if the compute is `stopped`, ask the
 *      provider to start it (EC2 StartInstances, k8s pod boot, ...).
 *      1 retry, 2_000ms backoff: providers occasionally need a moment
 *      to register the start before health probes succeed.
 *   2. `ensure-reachable`   -- transport setup (SSM port-forward, kubectl
 *      port-forward, microVM bridge). Idempotent + already probes
 *      internally; no retry.
 *   3. `flush-secrets`      -- replay deferred typed-secret placement
 *      onto the compute medium. Must run BEFORE prepare-workspace
 *      because the workspace clone uses the SSH key the placement
 *      delivered (the SSH key is for git, not for the compute transport).
 *      1 retry, 1_000ms backoff for transient transport blips.
 *   4. `prepare-workspace`  -- mkdir + git clone via arkd HTTP. 2
 *      retries, 1_000ms backoff (matches the legacy `git-clone` step
 *      that lived inside `RemoteWorktreeProvider.launch`).
 *   5. `isolation-prepare`    -- bring up compose / build devcontainer /
 *      boot microVM. Idempotent; 1 retry / 1_000ms backoff.
 *   6. `launch-agent`       -- arkd-side process spawn. NOT retried
 *      (tmux session names don't dedupe; a retry would leak the prior
 *      pane).
 *
 * Step ordering note: the legacy `RemoteWorktreeProvider.launch` ran
 * `flushDeferredPlacement` BEFORE `git clone` because the clone needs
 * the SSH key the placement just delivered. We preserve that order
 * here -- flush-secrets sits at step 3, prepare-workspace at step 4.
 *
 * Each step emits a `provisioning_step` event with `compute` +
 * `computeKind` context so the session timeline shows a uniform
 * per-phase trail. Failures throw `ProvisionStepError(step, cause)`
 * so the dispatch failure message names the failing phase.
 */

import type { AppContext } from "../../app.js";
import type { AgentHandle, ComputeHandle, LaunchOpts, PrepareCtx } from "../../compute/core/types.js";
import type { ComputeTarget } from "../../compute/core/compute-target.js";
import type { DeferredPlacementCtx } from "../../secrets/deferred-placement-ctx.js";
import { provisionStep } from "../provisioning-steps.js";

export interface RunTargetLifecycleOpts {
  /** Optional override for the prepare context's workdir / config / log. */
  prepareCtx?: Partial<PrepareCtx>;
  /**
   * When true, auto-start the compute if `opts.computeStatus === "stopped"`.
   * Default true; set false for callers that manage start/stop themselves.
   */
  autoStart?: boolean;
  /**
   * Source URL + remote-side workdir for the per-session worktree. When
   * non-null, `target.compute.prepareWorkspace` runs (mkdir + git clone via
   * arkd). Pass `null` for bare-worktree sessions or when the compute
   * shares the conductor's filesystem.
   */
  workspace?: { source: string | null; remoteWorkdir: string | null };
  /**
   * Deferred placement queue from the dispatcher's `buildLaunchEnv` pass.
   * When present and non-empty, `target.compute.flushPlacement` flushes it
   * before `prepare-workspace` (the workspace clone uses the SSH key the
   * placement delivered). SSH-private-key files, ssh config blocks, and
   * known_hosts entries are delivered through the compute's medium here.
   */
  placement?: DeferredPlacementCtx;
  /**
   * When true (default), `target.compute.ensureReachable` runs every
   * dispatch -- including rehydrated handles where the SSM port-forward
   * (or other transport) may have died. Set false only when you know
   * the transport is up (e.g., immediately after a fresh provision in
   * the same call site).
   */
  ensureReachable?: boolean;
  /**
   * Compute-status snapshot from the dispatcher (e.g. `compute.status`
   * field on the DB row). Drives the auto-start decision. Pass `"running"`
   * to skip the start step explicitly.
   */
  computeStatus?: string;
  /**
   * Optional override for the terminal `launch-agent` step. When provided
   * runTargetLifecycle calls this fn instead of `target.launchAgent` --
   * lets a runtime use a generic `provider.spawnProcess` (claude-agent
   * headless model, future runtimes) instead of the legacy tmux launch
   * embedded in the isolation impls. Returns the AgentHandle the caller
   * wants to track in the session row.
   */
  launchOverride?: () => Promise<AgentHandle>;
}

export async function runTargetLifecycle(
  app: AppContext,
  sessionId: string,
  target: ComputeTarget,
  handle: ComputeHandle,
  launchOpts: LaunchOpts,
  opts: RunTargetLifecycleOpts = {},
): Promise<AgentHandle> {
  const ctx: PrepareCtx = {
    workdir: opts.prepareCtx?.workdir ?? launchOpts.workdir,
    config: opts.prepareCtx?.config,
    onLog: opts.prepareCtx?.onLog,
  };
  const stepCtx = { compute: handle.name, computeKind: handle.kind };
  const onLog = opts.prepareCtx?.onLog;

  // 1. compute-start -- only when caller opted in AND the compute reports
  //    stopped. Providers can legitimately take a moment to register the
  //    start (StartInstances ack, k8s pod scheduling); 1 retry covers it.
  if (opts.autoStart !== false && opts.computeStatus === "stopped") {
    await provisionStep(app, sessionId, "compute-start", () => target.compute.start(handle), {
      retries: 1,
      retryBackoffMs: 2_000,
      context: stepCtx,
    });
  }

  // 2. ensure-reachable -- impl is idempotent and probes internally, so
  //    no retry budget. Skipped when the compute kind doesn't need
  //    transport setup (LocalCompute) or when caller declares the
  //    transport is already up.
  if (opts.ensureReachable !== false && target.compute.ensureReachable) {
    await provisionStep(
      app,
      sessionId,
      "ensure-reachable",
      () => target.compute.ensureReachable!(handle, { app, sessionId, onLog }),
      { context: stepCtx },
    );
  }

  // 3. flush-secrets -- runs BEFORE prepare-workspace because the workspace
  //    clone uses the SSH key the placement just delivered (matches legacy
  //    RemoteWorktreeProvider.launch ordering: flushDeferredPlacement →
  //    git-clone → launch-agent). Skip when the queue has no file/
  //    provisioner ops -- env-only sessions have nothing to flush.
  if (opts.placement && opts.placement.hasDeferred() && target.compute.flushPlacement) {
    await provisionStep(
      app,
      sessionId,
      "flush-secrets",
      () => target.compute.flushPlacement!(handle, { placement: opts.placement!, sessionId, onLog }),
      { retries: 1, retryBackoffMs: 1_000, context: stepCtx },
    );
  }

  // 4. prepare-workspace -- mkdir + git clone via arkd. Mirrors the legacy
  //    `git-clone` step's retry budget (2 retries, 1_000ms). Skipped when
  //    the source URL or remote workdir is null (bare worktree mode).
  if (opts.workspace?.source && opts.workspace.remoteWorkdir && target.compute.prepareWorkspace) {
    await provisionStep(
      app,
      sessionId,
      "prepare-workspace",
      () =>
        target.compute.prepareWorkspace!(handle, {
          source: opts.workspace!.source,
          remoteWorkdir: opts.workspace!.remoteWorkdir,
          sessionId,
          onLog,
        }),
      { retries: 2, retryBackoffMs: 1_000, context: stepCtx },
    );
  }

  // 5. isolation-prepare -- existing behaviour, kept.
  await provisionStep(app, sessionId, "isolation-prepare", () => target.prepare(handle, ctx), {
    retries: 1,
    retryBackoffMs: 1_000,
    context: stepCtx,
  });

  // 6. launch-agent -- terminal step. When `launchOverride` is set the
  // runtime owns spawning (e.g. claude-agent uses provider.spawnProcess on
  // arkd's generic /process/spawn instead of the isolation's tmux-based
  // launchAgent); otherwise we keep the legacy isolation-driven path.
  return provisionStep(
    app,
    sessionId,
    "launch-agent",
    () => (opts.launchOverride ? opts.launchOverride() : target.launchAgent(handle, launchOpts)),
    { context: { ...stepCtx, tmuxName: launchOpts.tmuxName } },
  );
}
