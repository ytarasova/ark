/**
 * SnapshotStore -- persistence for compute snapshots.
 *
 * A Compute produces an opaque `Snapshot` via `compute.snapshot(handle)`; the
 * payload bytes (VM memory file, disk diff, tarball, ...) live somewhere on
 * disk / remote storage. `SnapshotStore` owns the persistence + retrieval of
 * those bytes so the `Compute` impl doesn't have to care whether the caller
 * is on the ark host or a control-plane worker.
 *
 * Phase 3 ships a single filesystem-backed implementation
 * (`FsSnapshotStore`). Future PRs add S3 / GCS backends; the interface is
 * shaped to keep that door open (stream-based, metadata opaque).
 *
 * See `.workflow/plan/compute-runtime-vision.md` Phase 3.
 */

import type { ComputeKind } from "./types.js";

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Lightweight descriptor persisted alongside the payload. The `metadata` bag
 * is compute-specific -- Firecracker puts `{ memFilePath, stateFilePath }`
 * there; EC2 puts `{ amiId }`; etc. Opaque to the store.
 */
export interface SnapshotRef {
  /** Unique id. Minted by `save()`; used as the key for `load()` / `delete()`. */
  id: string;
  computeKind: ComputeKind;
  /** Session this snapshot belongs to. Used as a filter in `list()`. */
  sessionId: string;
  /** ISO-8601 timestamp set by `save()`. */
  createdAt: string;
  /** Size of the payload in bytes. Filled in by `save()`. */
  sizeBytes: number;
  /** Compute-specific metadata (e.g. firecracker memfile/state paths). */
  metadata: Record<string, unknown>;
}

/**
 * A loaded snapshot: the persisted descriptor plus a stream of the payload.
 * The consumer is responsible for consuming / closing the stream.
 */
export interface SnapshotBlob {
  ref: SnapshotRef;
  /** Stream of the snapshot payload. Opaque bytes; `compute.restore()` interprets. */
  stream: ReadableStream<Uint8Array>;
}

/** Filter passed to `list()`. All fields are AND-combined. */
export interface SnapshotListFilter {
  sessionId?: string;
  computeKind?: ComputeKind;
}

/**
 * Persistence contract. Impls must:
 *   - mint a unique `id` on `save()` (callers supply only the descriptor fields
 *     that are not derived from the persistence step);
 *   - fill in `createdAt` + `sizeBytes` from the save itself;
 *   - round-trip `metadata` verbatim.
 *
 * Threading: impls should allow concurrent `save()` calls (each one uses a
 * fresh id), but are not required to serialize reads against writes of the
 * same id -- callers that race a `load()` and a `delete()` on the same id
 * get an implementation-defined result.
 */
export interface SnapshotStore {
  /**
   * Persist the payload bytes and return the finalized ref.
   * The caller supplies `{ computeKind, sessionId, metadata }`; the store
   * fills in `id`, `createdAt`, and `sizeBytes`.
   */
  save(
    ref: Omit<SnapshotRef, "id" | "createdAt" | "sizeBytes">,
    stream: ReadableStream<Uint8Array>,
  ): Promise<SnapshotRef>;

  /** Retrieve the ref + payload stream for a previously saved snapshot. */
  load(id: string): Promise<SnapshotBlob>;

  /** Remove a snapshot. No-op if the id is unknown. */
  delete(id: string): Promise<void>;

  /** List snapshot refs. `filter` is AND-combined; missing fields match all. */
  list(filter?: SnapshotListFilter): Promise<SnapshotRef[]>;
}

/** Thrown by `load()` / `delete()` when the id is unknown. */
export class SnapshotNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`snapshot not found: ${id}`);
    this.name = "SnapshotNotFoundError";
  }
}
