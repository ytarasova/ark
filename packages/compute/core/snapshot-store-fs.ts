/**
 * FsSnapshotStore -- default filesystem implementation of `SnapshotStore`.
 *
 * Layout under the configured root (default `<arkDir>/snapshots/`):
 *
 *   <root>/
 *     <id>/
 *       ref.json    -- serialized `SnapshotRef`
 *       blob.bin    -- payload bytes (opaque to this layer)
 *
 * Each snapshot id directory is self-contained, so concurrent `save()` calls
 * can't collide (each one mints its own nanoid). `list()` scans the root for
 * `ref.json` files; malformed or missing ref files are silently skipped so
 * that a half-written snapshot doesn't break listing.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { createWriteStream, createReadStream } from "fs";
import { join } from "path";
import { Readable } from "stream";
import { nanoid } from "nanoid";

import type { SnapshotBlob, SnapshotListFilter, SnapshotRef, SnapshotStore } from "./snapshot-store.js";
import { SnapshotNotFoundError } from "./snapshot-store.js";

const REF_FILE = "ref.json";
const BLOB_FILE = "blob.bin";

export class FsSnapshotStore implements SnapshotStore {
  constructor(private readonly root: string) {}

  /** Absolute path of the snapshot directory for a given id. */
  private dir(id: string): string {
    return join(this.root, id);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async save(
    ref: Omit<SnapshotRef, "id" | "createdAt" | "sizeBytes">,
    stream: ReadableStream<Uint8Array>,
  ): Promise<SnapshotRef> {
    await this.ensureRoot();
    const id = nanoid();
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });

    // Pipe the web stream into a node writable. We count bytes as they flow
    // so that `sizeBytes` reflects exactly what was written.
    const blobPath = join(dir, BLOB_FILE);
    const out = createWriteStream(blobPath);
    let sizeBytes = 0;

    const nodeReadable = Readable.fromWeb(stream as unknown as import("stream/web").ReadableStream<Uint8Array>);
    await new Promise<void>((resolve, reject) => {
      nodeReadable.on("data", (chunk: Buffer | Uint8Array) => {
        sizeBytes += chunk.byteLength ?? chunk.length ?? 0;
      });
      nodeReadable.on("error", reject);
      out.on("error", reject);
      out.on("finish", () => resolve());
      nodeReadable.pipe(out);
    });

    const finalized: SnapshotRef = {
      id,
      computeKind: ref.computeKind,
      sessionId: ref.sessionId,
      createdAt: new Date().toISOString(),
      sizeBytes,
      metadata: ref.metadata ?? {},
    };

    await writeFile(join(dir, REF_FILE), JSON.stringify(finalized, null, 2), "utf-8");
    return finalized;
  }

  async load(id: string): Promise<SnapshotBlob> {
    const ref = await this.readRef(id);
    if (!ref) throw new SnapshotNotFoundError(id);

    // Verify the blob still exists -- a half-deleted snapshot should surface
    // as not-found rather than hand back a broken stream.
    const blobPath = join(this.dir(id), BLOB_FILE);
    try {
      await stat(blobPath);
    } catch {
      throw new SnapshotNotFoundError(id);
    }

    const nodeStream = createReadStream(blobPath);
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
    return { ref, stream: webStream };
  }

  async delete(id: string): Promise<void> {
    const dir = this.dir(id);
    try {
      await stat(dir);
    } catch {
      // Unknown id -- treat as a no-op per the contract.
      return;
    }
    await rm(dir, { recursive: true, force: true });
  }

  async list(filter?: SnapshotListFilter): Promise<SnapshotRef[]> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch (e: any) {
      if (e?.code === "ENOENT") return [];
      throw e;
    }

    const out: SnapshotRef[] = [];
    for (const name of entries) {
      const ref = await this.readRef(name);
      if (!ref) continue;
      if (filter?.sessionId && ref.sessionId !== filter.sessionId) continue;
      if (filter?.computeKind && ref.computeKind !== filter.computeKind) continue;
      out.push(ref);
    }
    // Stable order (newest first) so callers can pick "the latest snapshot"
    // without another round-trip.
    out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return out;
  }

  /** Read + parse the `ref.json` for an id. Returns null on any failure. */
  private async readRef(id: string): Promise<SnapshotRef | null> {
    const refPath = join(this.dir(id), REF_FILE);
    let raw: string;
    try {
      raw = await readFile(refPath, "utf-8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as SnapshotRef;
    } catch {
      return null;
    }
  }
}
