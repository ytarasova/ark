/**
 * Resolve `(target, handle)` for a session ready to dispatch.
 *
 * The dispatcher needs both a `ComputeTarget` (Compute × Runtime
 * composition) AND a `ComputeHandle` (per-instance state: EC2 instance
 * id, k8s pod name, container id, ...). The legacy `ComputeProvider`
 * threaded the `Compute` row directly; the new path threads a handle
 * so multi-stage dispatch can resume against the same provisioned
 * compute without re-provisioning every time.
 *
 * Behaviour:
 *
 *   1. `app.resolveComputeTarget(session)` returns the `(target,
 *      compute)` pair; on no compute we early-return null.
 *   2. If `session.config.compute_handle` exists, we rehydrate it. This
 *      is the steady-state path for second-stage dispatches (verify,
 *      pr, merge) on the same session and for resume-after-conductor-
 *      restart.
 *   3. Otherwise we provision a fresh handle through `target.provision`
 *      (which consults the pool registry when the Compute supports it)
 *      and persist the handle on `session.config.compute_handle` so
 *      step 2 fires next time.
 *
 * Persisting the handle on the session row is intentional: the handle
 * IS session state. Compute lifetime is per-session for templates
 * (k8s pod, docker container) and per-fleet for persistent EC2; either
 * way the session is the canonical owner of the handle.
 */

import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/index.js";
import type { ComputeHandle } from "../../../compute/core/types.js";
import type { ComputeTarget } from "../../../compute/core/compute-target.js";
import { logInfo } from "../../observability/structured-log.js";

export interface ResolvedTarget {
  target: ComputeTarget | null;
  handle: ComputeHandle | null;
}

export async function resolveTargetAndHandle(app: AppContext, session: Session): Promise<ResolvedTarget> {
  const { target } = await app.resolveComputeTarget(session);
  if (!target) return { target: null, handle: null };

  const persisted = readPersistedHandle(session);
  if (persisted) {
    return { target, handle: persisted };
  }

  // First dispatch on this session: provision a fresh handle. Pool
  // consultation lives inside ComputeTarget.provision -- callers
  // don't need to know whether the compute was pooled or directly
  // provisioned.
  const handle = await target.provision({ size: undefined });
  await persistHandle(app, session, handle);
  logInfo("dispatch", `provisioned new handle for session ${session.id} (${handle.kind}/${handle.name})`, {
    sessionId: session.id,
    computeKind: handle.kind,
    computeName: handle.name,
  });
  return { target, handle };
}

function readPersistedHandle(session: Session): ComputeHandle | null {
  const cfg = session.config as { compute_handle?: ComputeHandle } | null | undefined;
  return cfg?.compute_handle ?? null;
}

async function persistHandle(app: AppContext, session: Session, handle: ComputeHandle): Promise<void> {
  await app.sessions.update(session.id, {
    config: { ...((session.config as object | null) ?? {}), compute_handle: handle },
  });
}
