/**
 * Resolve `(target, handle)` for a session ready to dispatch.
 *
 * The dispatcher needs both a `ComputeTarget` (Compute × Isolation
 * composition) AND a `ComputeHandle` (per-instance state: EC2 instance
 * id, k8s pod name, container id, ...). Threading a handle (rather than
 * just the compute row) lets multi-stage dispatch resume against the
 * same provisioned compute without re-provisioning every time.
 *
 * Behaviour (precedence order):
 *
 *   1. `app.resolveComputeTarget(session)` returns the `(target,
 *      compute)` pair; on no compute we early-return null.
 *   2. If `session.config.compute_handle` holds a persisted state
 *      blob, route it through `Compute.rehydrateHandle(state)`. This
 *      is the steady-state path for second-stage dispatches (verify,
 *      pr, merge) on the same session and for resume-after-conductor-
 *      restart. Method closures don't survive `JSON.stringify`, so
 *      rehydration is the seam that re-attaches them.
 *   3. Else if the Compute can synthesize a handle from the row
 *      (`Compute.attachExistingHandle`), use that. This is the fast
 *      path for "live" persistent computes -- LocalCompute (always)
 *      and EC2Compute against a row whose status=running with an
 *      `instance_id` already in `compute.config`. Skips a redundant
 *      `provision()` call that would otherwise try to build a new
 *      CloudFormation stack on top of an existing instance and hang
 *      on AWS SDK calls.
 *   4. Otherwise provision a fresh handle through `target.provision`
 *      (which consults the pool registry when the Compute supports
 *      it). The provision call is wrapped in `provisionStep` so the
 *      session timeline shows a `provisioning_step` started/ok/failed
 *      event even when this code path runs -- without that, a hung
 *      provision is invisible to the UI until the dispatch watchdog
 *      fires (5min).
 *
 * Persistence shape: only `PersistedComputeHandleState` (kind / name /
 * meta) goes into `session.config.compute_handle`. The methoded
 * `ComputeHandle` is in-memory only; treating it as serialisable was
 * the bug behind "compute kind 'X' has no spawnProcess on its handle"
 * after a multi-stage dispatch read the methodless JSON back out.
 */

import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/index.js";
import type { ComputeHandle, PersistedComputeHandleState } from "../../compute/types.js";
import type { ComputeTarget } from "../../compute/compute-target.js";
import { logInfo } from "../../observability/structured-log.js";
import { provisionStep } from "../provisioning-steps.js";

export interface ResolvedTarget {
  target: ComputeTarget | null;
  handle: ComputeHandle | null;
}

export async function resolveTargetAndHandle(app: AppContext, session: Session): Promise<ResolvedTarget> {
  const { target, compute } = await app.resolveComputeTarget(session);
  if (!target) return { target: null, handle: null };

  const persistedState = readPersistedHandleState(session);
  if (persistedState) {
    // Persisted state is JSON-only -- no method closures survive the DB
    // round-trip. `Compute.rehydrateHandle` is the single seam that
    // re-attaches them, so callers always see a fully-methoded handle.
    return { target, handle: target.compute.rehydrateHandle(persistedState) };
  }

  // Fast path: ask the Compute impl whether it can synthesize a handle
  // from the existing compute row. For LocalCompute this is always yes;
  // for EC2Compute it returns a handle when `compute.config.instance_id`
  // is set (i.e., the instance was already provisioned out-of-band or
  // by a prior session). When this returns null we fall through to a
  // fresh `provision()` -- the legitimate path for template computes
  // (k8s, firecracker) where each session gets its own instance.
  if (compute && target.compute.attachExistingHandle) {
    const existing = target.compute.attachExistingHandle({
      name: compute.name,
      status: compute.status,
      config: (compute.config as Record<string, unknown> | null) ?? {},
    });
    if (existing) {
      await persistHandleState(app, session, existing);
      logInfo(
        "dispatch",
        `attached to existing compute for session ${session.id} (${existing.kind}/${existing.name})`,
        { sessionId: session.id, computeKind: existing.kind, computeName: existing.name },
      );
      return { target, handle: existing };
    }
  }

  // First dispatch on this session AND no existing compute to attach: provision
  // a fresh handle. Wrap in `provisionStep` so the session timeline shows the
  // attempt as a structured `provisioning_step` event rather than going dark.
  // Pool consultation lives inside ComputeTarget.provision -- callers don't
  // need to know whether the compute was pooled or directly provisioned.
  const handle = await provisionStep(
    app,
    session.id,
    "compute-provision",
    () => target.provision({ size: undefined }),
    {
      context: { computeKind: target.compute.kind },
    },
  );
  await persistHandleState(app, session, handle);
  logInfo("dispatch", `provisioned new handle for session ${session.id} (${handle.kind}/${handle.name})`, {
    sessionId: session.id,
    computeKind: handle.kind,
    computeName: handle.name,
  });
  return { target, handle };
}

/**
 * Read the persisted handle state from `session.config.compute_handle`.
 *
 * Stored shape is `PersistedComputeHandleState` (kind / name / meta) -- the
 * methoded `ComputeHandle` is a runtime-only construct that has to be
 * rehydrated via `Compute.rehydrateHandle` on every read, since method
 * closures don't survive `JSON.stringify` into the session config.
 *
 * Legacy rows that wrote the full handle object are still readable: we only
 * touch the three state fields and ignore any stale method-named keys that
 * may have been serialised as undefined.
 */
function readPersistedHandleState(session: Session): PersistedComputeHandleState | null {
  const cfg = session.config as { compute_handle?: PersistedComputeHandleState } | null | undefined;
  const stored = cfg?.compute_handle;
  if (!stored || typeof stored.kind !== "string" || typeof stored.name !== "string") return null;
  return { kind: stored.kind, name: stored.name, meta: (stored.meta as Record<string, unknown> | undefined) ?? {} };
}

async function persistHandleState(app: AppContext, session: Session, handle: ComputeHandle): Promise<void> {
  // Strip method closures before persisting -- they can't survive JSON
  // serialisation, and writing them in just produces undefined fields that
  // confuse later readers. Persist only the data fields; rehydrateHandle
  // re-attaches behaviour on read.
  const state: PersistedComputeHandleState = { kind: handle.kind, name: handle.name, meta: handle.meta };
  await app.sessions.update(session.id, {
    config: { ...((session.config as object | null) ?? {}), compute_handle: state },
  });
}
