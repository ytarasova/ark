/**
 * Run a `ComputeTarget`'s prepare → launchAgent half-lifecycle inside
 * structured `provisioning_step` events.
 *
 * The dispatcher's job after `resolveTargetAndHandle` returned a
 * `(target, handle)` pair is to:
 *
 *   1. Run runtime preparation (`target.prepare`) — bring up
 *      compose / build devcontainer / boot microVM. Idempotent;
 *      retried once on transient failures.
 *   2. Launch the agent (`target.launchAgent`) — arkd-side process
 *      spawn. NOT retried (tmux session names don't dedupe; a retry
 *      would leak the prior pane).
 *
 * Each phase emits a `provisioning_step` event with timing + retry
 * attempts so the session timeline shows a uniform per-phase trail.
 * Failures throw `ProvisionStepError(step, cause)` so the dispatch
 * failure message names the failing phase.
 */

import type { AppContext } from "../../app.js";
import type { AgentHandle, ComputeHandle, LaunchOpts, PrepareCtx } from "../../../compute/core/types.js";
import type { ComputeTarget } from "../../../compute/core/compute-target.js";
import { provisionStep } from "../provisioning-steps.js";

export interface RunTargetLifecycleOpts {
  /** Optional override for the prepare context's workdir / config / log. */
  prepareCtx?: Partial<PrepareCtx>;
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

  await provisionStep(app, sessionId, "runtime-prepare", () => target.prepare(handle, ctx), {
    retries: 1,
    retryBackoffMs: 1_000,
    context: stepCtx,
  });

  return provisionStep(app, sessionId, "launch-agent", () => target.launchAgent(handle, launchOpts), {
    context: { ...stepCtx, tmuxName: launchOpts.tmuxName },
  });
}
