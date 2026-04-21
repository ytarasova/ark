/**
 * LocalDiskBlobStore round-trip + tenant enforcement + locator opacity.
 *
 * These tests don't need an AppContext -- the store is a leaf utility. We
 * mkdtemp a fresh root per file so parallel workers don't collide.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LocalDiskBlobStore } from "../local-disk.js";
import { decodeLocator, LOCAL_TENANT_ID } from "../blob-store.js";

let root: string;
let store: LocalDiskBlobStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "ark-blob-local-"));
  store = new LocalDiskBlobStore(root);
});

afterAll(() => {
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe("LocalDiskBlobStore", async () => {
  it("puts then gets the same bytes", async () => {
    const bytes = Buffer.from("hello world", "utf-8");
    const meta = await store.put(
      { tenantId: LOCAL_TENANT_ID, namespace: "inputs", id: "r1", filename: "greeting.txt" },
      bytes,
      { contentType: "text/plain" },
    );
    expect(meta.locator).toBeTruthy();
    expect(meta.size).toBe(bytes.length);
    expect(meta.filename).toBe("greeting.txt");

    const out = await store.get(meta.locator, LOCAL_TENANT_ID);
    expect(out.bytes.toString("utf-8")).toBe("hello world");
    expect(out.meta.filename).toBe("greeting.txt");
  });

  it("rejects cross-tenant reads", async () => {
    const { locator } = await store.put(
      { tenantId: "tenant-a", namespace: "inputs", id: "r2", filename: "a.txt" },
      Buffer.from("a"),
    );
    (await expect(store.get(locator, "tenant-b"))).rejects.toThrow(/tenant/i);
  });

  it("rejects cross-tenant deletes", async () => {
    const { locator } = await store.put(
      { tenantId: "tenant-a", namespace: "inputs", id: "r3", filename: "a.txt" },
      Buffer.from("a"),
    );
    (await expect(store.delete(locator, "tenant-b"))).rejects.toThrow(/tenant/i);
  });

  it("delete removes the file + drops empty parent dirs", async () => {
    const { locator } = await store.put(
      { tenantId: "tenant-c", namespace: "inputs", id: "r4", filename: "bye.txt" },
      Buffer.from("bye"),
    );
    await store.delete(locator, "tenant-c");
    // Read back should fail.
    (await expect(store.get(locator, "tenant-c"))).rejects.toThrow();
    // Per-blob dir cleaned up.
    const perBlobDir = join(root, "tenant-c", "inputs", "r4");
    expect(existsSync(perBlobDir)).toBe(false);
  });

  it("locator is opaque base64url-encoded key tuple", async () => {
    const { locator } = await store.put(
      { tenantId: LOCAL_TENANT_ID, namespace: "inputs", id: "r5", filename: "opaque.bin" },
      Buffer.from([1, 2, 3]),
    );
    // Opaque to the caller -- no filesystem path embedded.
    expect(locator).not.toInclude(root);
    expect(locator).not.toInclude("/");
    // But the store parses it back into the original tuple.
    const key = decodeLocator(locator);
    expect(key).toEqual({
      tenantId: LOCAL_TENANT_ID,
      namespace: "inputs",
      id: "r5",
      filename: "opaque.bin",
    });
  });

  it("rejects payloads larger than maxBytes", async () => {
    const big = Buffer.alloc(1024, 0x41);
    (
      await expect(
        store.put({ tenantId: LOCAL_TENANT_ID, namespace: "inputs", id: "r6", filename: "big.bin" }, big, {
          maxBytes: 512,
        }),
      )
    ).rejects.toThrow(/exceeds maxBytes/);
  });
});
