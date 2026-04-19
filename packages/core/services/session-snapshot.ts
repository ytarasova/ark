/**
 * Session snapshot orchestration -- Phase 3 foundation.
 *
 * `pauseWithSnapshot` / `resumeFromSnapshot` are the higher-level counterparts
 * to the state-only `pause` / `resume` in `session-lifecycle.ts`. They talk
 * to the new `Compute` interface (`packages/compute/core/types.ts`) and the
 * `SnapshotStore` to actually persist VM/container state so that a session
 * can move between hosts or survive an ark restart.
 *
 * Compute backends that don't declare `capabilities.snapshot === true`
 * (today: `LocalCompute`, vanilla `K8sCompute`) throw `NotSupportedError`
 * from their `snapshot()` / `restore()` methods. This module surfaces the
 * error cleanly so the RPC layer can translate it into a structured
 * response.
 *
 * NOTE: This file is intentionally minimal. The end-to-end wiring (look up
 * the session's compute target, save the snapshot bytes, update DB state,
 * restart arkd) will thicken as subsequent Phase 3 PRs land.
 */

import type { AppContext } from "../app.js";
import type { ComputeKind, ComputeHandle, Snapshot } from "../../compute/core/types.js";
import type { SnapshotRef } from "../../compute/core/snapshot-store.js";
import { NotSupportedError } from "../../compute/core/types.js";

// ── Public result shapes ───────────────────────────────────────────────────

export interface PauseWithSnapshotResult {
  ok: boolean;
  message: string;
  /** Populated on success. */
  snapshot?: SnapshotRef;
  /** True when the underlying compute lacks snapshot capability. */
  notSupported?: boolean;
}

export interface ResumeFromSnapshotResult {
  ok: boolean;
  message: string;
  /** Populated on success. */
  snapshotId?: string;
  /** True when the underlying compute lacks snapshot capability. */
  notSupported?: boolean;
}

// ── Session -> compute resolution ──────────────────────────────────────────

/**
 * Resolve the `Compute` a session runs on, plus a stub handle derived from
 * the session row.
 *
 * Wave 3 replaces this with the DB `compute_kind` column and a proper
 * `ComputeTarget` lookup; for now we derive the kind from
 * `session.compute_name`'s suffix (local-*, ec2-*, firecracker-*, k8s-*)
 * which matches the seeded names in the repo. Unknown or missing computes
 * resolve to `local`.
 */
export function resolveSessionCompute(
  app: AppContext,
  sessionId: string,
): { kind: ComputeKind; handle: ComputeHandle } | null {
  const session = app.sessions.get(sessionId);
  if (!session) return null;

  const name = session.compute_name || "local";
  const kind = inferComputeKind(name);
  const compute = app.getCompute(kind);
  if (!compute) return null;

  // Derive a handle from the session row. Real handles are minted by
  // `compute.provision()` during dispatch; this reconstructs one with the
  // same (kind, name) pair plus any handle-meta we persisted on the session.
  const meta = ((session.config as Record<string, unknown> | undefined)?.compute_handle ?? {}) as Record<
    string,
    unknown
  >;
  return { kind, handle: { kind, name, meta } };
}

/** Map a compute row name to the new `ComputeKind` taxonomy. */
function inferComputeKind(name: string): ComputeKind {
  if (name.startsWith("firecracker")) return "firecracker";
  if (name.startsWith("ec2")) return "ec2";

  if (name.startsWith("k8s-kata")) return "k8s-kata";
  if (name.startsWith("k8s")) return "k8s";

  return "local";
}

// ── Pause / resume with snapshot persistence ───────────────────────────────

/**
 * Snapshot the compute and persist the payload, then mark the session paused.
 *
 * Flow:
 *   1. Resolve the session's compute + handle.
 *   2. Short-circuit with `NotSupportedError` if the backend can't snapshot.
 *   3. Call `compute.snapshot(handle)` -- backend produces a `Snapshot`
 *      (metadata only; the actual bytes are still on the compute host).
 *   4. Stream the payload into the `SnapshotStore`.
 *   5. Record the finalized `SnapshotRef` on the session + emit an event.
 */
export async function pauseWithSnapshot(
  app: AppContext,
  sessionId: string,
  opts?: { reason?: string },
): Promise<PauseWithSnapshotResult> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const resolved = resolveSessionCompute(app, sessionId);
  if (!resolved) return { ok: false, message: "Session has no resolvable compute" };
  const compute = app.getCompute(resolved.kind);
  if (!compute) return { ok: false, message: `Compute not registered: ${resolved.kind}` };

  if (!compute.capabilities.snapshot) {
    const err = new NotSupportedError(resolved.kind, "snapshot");
    return { ok: false, notSupported: true, message: err.message };
  }

  // Step 1: ask the backend to produce a snapshot + a stream of its bytes.
  let snap: Snapshot;
  let payload: ReadableStream<Uint8Array>;
  try {
    const res = await produceSnapshot(compute, resolved.handle);
    snap = res.snapshot;
    payload = res.stream;
  } catch (e: any) {
    if (e instanceof NotSupportedError) {
      return { ok: false, notSupported: true, message: e.message };
    }
    return { ok: false, message: `snapshot failed: ${e?.message ?? e}` };
  }

  // Step 2: persist to the configured SnapshotStore.
  let ref: SnapshotRef;
  try {
    ref = await app.snapshotStore.save(
      {
        computeKind: snap.computeKind,
        sessionId,
        metadata: snap.metadata,
      },
      payload,
    );
  } catch (e: any) {
    return { ok: false, message: `snapshot persist failed: ${e?.message ?? e}` };
  }

  // Step 3: mark session paused + record the snapshot id in session.config
  // so `resume` can find it without a separate table.
  const mergedConfig = {
    ...(session.config as Record<string, unknown> | undefined),
    last_snapshot_id: ref.id,
    last_snapshot_at: ref.createdAt,
  };
  app.sessions.update(sessionId, {
    status: "blocked",
    breakpoint_reason: opts?.reason ?? "User paused",
    config: mergedConfig,
  });

  app.events.log(sessionId, "session_paused", {
    stage: session.stage,
    actor: "user",
    data: {
      reason: opts?.reason,
      was_status: session.status,
      snapshot_id: ref.id,
      snapshot_bytes: ref.sizeBytes,
    },
  });

  return { ok: true, message: "Paused", snapshot: ref };
}

/**
 * Load a persisted snapshot and restore the compute, then mark the session
 * active again. When `snapshotId` is omitted, the latest snapshot saved
 * under the session is used.
 */
export async function resumeFromSnapshot(
  app: AppContext,
  sessionId: string,
  opts?: { snapshotId?: string },
): Promise<ResumeFromSnapshotResult> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // Pick the snapshot id: explicit > session.last_snapshot_id > latest for session.
  let snapshotId = opts?.snapshotId;
  if (!snapshotId) {
    const cfg = (session.config ?? {}) as Record<string, unknown>;
    if (typeof cfg.last_snapshot_id === "string") snapshotId = cfg.last_snapshot_id;
  }
  if (!snapshotId) {
    const refs = await app.snapshotStore.list({ sessionId });
    if (refs.length === 0) return { ok: false, message: "No snapshot available for session" };
    snapshotId = refs[0].id; // `list()` returns newest-first
  }

  // Load the ref + payload stream.
  let blob: Awaited<ReturnType<typeof app.snapshotStore.load>>;
  try {
    blob = await app.snapshotStore.load(snapshotId);
  } catch (e: any) {
    return { ok: false, message: `snapshot load failed: ${e?.message ?? e}` };
  }

  const compute = app.getCompute(blob.ref.computeKind);
  if (!compute) return { ok: false, message: `Compute not registered: ${blob.ref.computeKind}` };

  if (!compute.capabilities.snapshot) {
    const err = new NotSupportedError(blob.ref.computeKind, "restore");
    return { ok: false, notSupported: true, message: err.message };
  }

  // Hand the blob back to the compute impl. Phase 3 follow-ups will push
  // the payload bytes across the wire; today the metadata (e.g. firecracker
  // memfile / statefile paths) is enough for the native implementations
  // that already exist.
  try {
    const reconstructed: Snapshot = {
      id: blob.ref.id,
      computeKind: blob.ref.computeKind,
      createdAt: blob.ref.createdAt,
      sizeBytes: blob.ref.sizeBytes,
      metadata: blob.ref.metadata,
    };
    await compute.restore(reconstructed);
  } catch (e: any) {
    if (e instanceof NotSupportedError) {
      return { ok: false, notSupported: true, message: e.message };
    }
    return { ok: false, message: `restore failed: ${e?.message ?? e}` };
  }

  app.sessions.update(sessionId, {
    status: "ready",
    breakpoint_reason: null,
  });

  app.events.log(sessionId, "session_resumed", {
    stage: session.stage,
    actor: "user",
    data: { from_status: session.status, snapshot_id: blob.ref.id },
  });

  return { ok: true, message: "Resumed", snapshotId: blob.ref.id };
}

// ── Internals ───────────────────────────────────────────────────────────────

/**
 * Adapter around `compute.snapshot()`. Today the `Compute` interface returns a
 * `Snapshot` descriptor only; the payload bytes live on the compute host and
 * the metadata fields (`memFilePath`, `stateFilePath`, ...) describe where.
 *
 * Until the `Compute` interface grows a native streaming variant in a
 * follow-up PR, we materialize an empty payload so the `SnapshotStore` still
 * has something to persist. `metadata` carries everything needed to
 * restore.
 */
async function produceSnapshot(
  compute: import("../../compute/core/types.js").Compute,
  handle: ComputeHandle,
): Promise<{ snapshot: Snapshot; stream: ReadableStream<Uint8Array> }> {
  const snap = await compute.snapshot(handle);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return { snapshot: snap, stream };
}
