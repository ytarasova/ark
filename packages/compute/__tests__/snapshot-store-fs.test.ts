/**
 * FsSnapshotStore unit tests.
 *
 * Covers the full CRUD cycle, list filtering, unique-id generation under
 * concurrency, and the missing-id error surface.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { readFile, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { FsSnapshotStore } from "../core/snapshot-store-fs.js";
import { SnapshotNotFoundError } from "../core/snapshot-store.js";

let root: string;
let store: FsSnapshotStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ark-snap-"));
  store = new FsSnapshotStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Helper: wrap bytes in a single-chunk ReadableStream. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Helper: drain a stream into one Uint8Array. */
async function drain(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = s.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

describe("FsSnapshotStore", () => {
  it("save() mints an id, fills createdAt + sizeBytes, and round-trips metadata", async () => {
    const payload = new TextEncoder().encode("hello snapshot");
    const before = Date.now() - 1;
    const ref = await store.save(
      { computeKind: "firecracker", sessionId: "s-abc", metadata: { memFilePath: "/tmp/m", custom: 42 } },
      streamOf(payload),
    );
    expect(ref.id).toBeTruthy();
    expect(ref.sessionId).toBe("s-abc");
    expect(ref.computeKind).toBe("firecracker");
    expect(ref.sizeBytes).toBe(payload.byteLength);
    expect(ref.metadata).toEqual({ memFilePath: "/tmp/m", custom: 42 });
    expect(new Date(ref.createdAt).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("load() returns the ref and a stream of the original bytes", async () => {
    const payload = new TextEncoder().encode("payload body 12345");
    const saved = await store.save({ computeKind: "ec2", sessionId: "s-xyz", metadata: {} }, streamOf(payload));
    const blob = await store.load(saved.id);
    expect(blob.ref.id).toBe(saved.id);
    const bytes = await drain(blob.stream);
    expect(new TextDecoder().decode(bytes)).toBe("payload body 12345");
  });

  it("persists ref.json on disk as structured JSON", async () => {
    const saved = await store.save(
      { computeKind: "firecracker", sessionId: "s-1", metadata: { a: 1 } },
      streamOf(new Uint8Array([1, 2, 3])),
    );
    const raw = await readFile(join(root, saved.id, "ref.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(saved.id);
    expect(parsed.metadata).toEqual({ a: 1 });
  });

  it("delete() removes the snapshot and subsequent load() throws", async () => {
    const saved = await store.save(
      { computeKind: "local", sessionId: "s-del", metadata: {} },
      streamOf(new Uint8Array([9, 9, 9])),
    );
    await store.delete(saved.id);
    await expect(store.load(saved.id)).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("delete() on an unknown id is a no-op", async () => {
    await store.delete("no-such-id");
    // no throw -> success
  });

  it("load() on an unknown id throws SnapshotNotFoundError", async () => {
    await expect(store.load("no-such-id")).rejects.toBeInstanceOf(SnapshotNotFoundError);
  });

  it("list() filters by sessionId and computeKind", async () => {
    const a = await store.save(
      { computeKind: "firecracker", sessionId: "s-1", metadata: {} },
      streamOf(new Uint8Array([1])),
    );
    const b = await store.save(
      { computeKind: "firecracker", sessionId: "s-2", metadata: {} },
      streamOf(new Uint8Array([2])),
    );
    const c = await store.save({ computeKind: "ec2", sessionId: "s-1", metadata: {} }, streamOf(new Uint8Array([3])));

    const all = await store.list();
    expect(all.length).toBe(3);

    const bySession = await store.list({ sessionId: "s-1" });
    expect(bySession.map((r) => r.id).sort()).toEqual([a.id, c.id].sort());

    const byKind = await store.list({ computeKind: "firecracker" });
    expect(byKind.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    const both = await store.list({ sessionId: "s-1", computeKind: "ec2" });
    expect(both.map((r) => r.id)).toEqual([c.id]);
  });

  it("list() returns newest snapshots first", async () => {
    const r1 = await store.save(
      { computeKind: "ec2", sessionId: "s-ord", metadata: {} },
      streamOf(new Uint8Array([1])),
    );
    // Force a measurable gap so createdAt differs.
    await new Promise((res) => setTimeout(res, 15));
    const r2 = await store.save(
      { computeKind: "ec2", sessionId: "s-ord", metadata: {} },
      streamOf(new Uint8Array([2])),
    );
    const list = await store.list({ sessionId: "s-ord" });
    expect(list.map((r) => r.id)).toEqual([r2.id, r1.id]);
  });

  it("concurrent save() calls mint unique ids and produce independent dirs", async () => {
    const saves = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.save(
          { computeKind: "firecracker", sessionId: `s-${i}`, metadata: { i } },
          streamOf(new TextEncoder().encode(`payload-${i}`)),
        ),
      ),
    );
    const ids = new Set(saves.map((s) => s.id));
    expect(ids.size).toBe(8);

    // Each saved ref should round-trip.
    for (const s of saves) {
      const blob = await store.load(s.id);
      const bytes = await drain(blob.stream);
      expect(new TextDecoder().decode(bytes)).toBe(`payload-${s.sessionId.slice(2)}`);
    }
  });

  it("list() tolerates stray files / malformed ref.json", async () => {
    const good = await store.save(
      { computeKind: "local", sessionId: "s-g", metadata: {} },
      streamOf(new Uint8Array([1])),
    );
    // Write a garbage directory alongside the good one.
    await mkdir(join(root, "garbage-dir"), { recursive: true });
    await writeFile(join(root, "garbage-dir", "ref.json"), "{not json}");
    const list = await store.list();
    expect(list.map((r) => r.id)).toEqual([good.id]);
  });
});
