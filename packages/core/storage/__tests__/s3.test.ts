/**
 * S3BlobStore integration tests -- run against a disposable LocalStack
 * container so we get real round-trip coverage without reaching out to AWS.
 *
 * The suite mirrors `local-disk.test.ts` case-for-case:
 *   - put/get round-trip with byte-level equality
 *   - contentType round-trip
 *   - cross-tenant reads rejected before a network call
 *   - cross-tenant deletes rejected
 *   - delete -> get yields NotFound
 *   - maxBytes rejection happens BEFORE the network call
 *   - locator is opaque (doesn't leak bucket / prefix / filesystem paths)
 *   - disjoint tenants land under disjoint prefixes (verified by listing)
 *
 * Docker gating: `isDockerAvailable()` runs once in the file-level setup;
 * when Docker isn't reachable the whole describe is skipped with a warning
 * (developer laptops without Docker, CI jobs on Docker-less runners).
 * On Linux GitHub-hosted runners Docker is preinstalled and the tests run.
 *
 * Cold start: LocalStack (3.8 image) boots in ~8-20s on a warm host. With
 * the 30s health poll + 45s test-level timeout we have headroom; the first
 * `docker pull` on a cold host is the only thing that can push us over.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { S3BlobStore } from "../s3.js";
import { decodeLocator, LOCAL_TENANT_ID } from "../blob-store.js";
import {
  isDockerAvailable,
  startLocalStack,
  setLocalStackCredentials,
  type LocalStackHandle,
} from "./localstack-helper.js";

// Gate the whole describe on Docker availability. We probe once during
// module load so individual tests don't re-pay the `docker ps` cost.
const dockerAvailable = await isDockerAvailable();
if (!dockerAvailable) {
  console.warn("[s3.test] Docker not available -- skipping LocalStack-backed S3 tests.");
}
const maybe = dockerAvailable ? describe : describe.skip;

maybe("S3BlobStore (LocalStack integration)", async () => {
  let ls: LocalStackHandle;
  let store: S3BlobStore;
  let restoreEnv: () => void;

  beforeAll(async () => {
    const creds = setLocalStackCredentials();
    restoreEnv = creds.restore;
    ls = await startLocalStack();
    store = new S3BlobStore({
      bucket: ls.bucket,
      region: "us-east-1",
      prefix: "ark-test",
      endpoint: ls.endpoint,
    });
  }, 60_000);

  afterAll(async () => {
    try {
      await store?.dispose?.();
    } finally {
      try {
        await ls?.stop();
      } finally {
        restoreEnv?.();
      }
    }
  }, 30_000);

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
    expect(out.bytes.equals(bytes)).toBe(true);
    expect(out.bytes.toString("utf-8")).toBe("hello world");
    expect(out.meta.filename).toBe("greeting.txt");
  });

  it("round-trips contentType", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const meta = await store.put(
      { tenantId: LOCAL_TENANT_ID, namespace: "inputs", id: "r-ct", filename: "pic.png" },
      bytes,
      { contentType: "image/png" },
    );
    const out = await store.get(meta.locator, LOCAL_TENANT_ID);
    expect(out.meta.contentType).toBe("image/png");
  });

  it("rejects cross-tenant reads", async () => {
    const { locator } = await store.put(
      { tenantId: "tenant-a", namespace: "inputs", id: "r2", filename: "a.txt" },
      Buffer.from("secret"),
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

  it("delete then get throws NotFound", async () => {
    const { locator } = await store.put(
      { tenantId: "tenant-c", namespace: "inputs", id: "r4", filename: "bye.txt" },
      Buffer.from("bye"),
    );
    await store.delete(locator, "tenant-c");
    // S3 GET on a missing key throws (NoSuchKey / 404). We don't care about
    // the exact error shape -- only that it surfaces.
    (await expect(store.get(locator, "tenant-c"))).rejects.toThrow();
  });

  it("rejects payloads larger than maxBytes BEFORE the network call", async () => {
    // Point at a bucket that doesn't exist on LocalStack. If the size check
    // ran after the PUT we would see a NoSuchBucket error, not the size
    // error; this test locks down that ordering.
    const oversizedStore = new S3BlobStore({
      bucket: "does-not-exist-on-purpose",
      region: "us-east-1",
      prefix: "ark-test",
      endpoint: ls.endpoint,
    });
    const big = Buffer.alloc(1024, 0x41);
    (
      await expect(
        oversizedStore.put({ tenantId: LOCAL_TENANT_ID, namespace: "inputs", id: "r-big", filename: "big.bin" }, big, {
          maxBytes: 512,
        }),
      )
    ).rejects.toThrow(/exceeds maxBytes/);
    await oversizedStore.dispose?.();
  });

  it("locator is opaque -- no bucket / prefix / endpoint leakage", async () => {
    const { locator } = await store.put(
      { tenantId: LOCAL_TENANT_ID, namespace: "inputs", id: "r5", filename: "opaque.bin" },
      Buffer.from([1, 2, 3]),
    );
    // The locator is the base64url of the tuple -- it must not contain
    // the bucket name, the prefix, the endpoint, or any slash.
    expect(locator).not.toInclude(ls.bucket);
    expect(locator).not.toInclude("ark-test");
    expect(locator).not.toInclude(ls.endpoint);
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

  it("disjoint tenants land under disjoint prefixes in S3", async () => {
    // Put one blob per tenant, then list the bucket and check that the
    // returned keys embed the expected tenant segment.
    await store.put({ tenantId: "tenant-x", namespace: "inputs", id: "rx", filename: "x.txt" }, Buffer.from("x"));
    await store.put({ tenantId: "tenant-y", namespace: "inputs", id: "ry", filename: "y.txt" }, Buffer.from("y"));

    const sdk = await import("@aws-sdk/client-s3");
    const client = new sdk.S3Client({
      region: "us-east-1",
      endpoint: ls.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    try {
      const xList = await client.send(
        new sdk.ListObjectsV2Command({ Bucket: ls.bucket, Prefix: "ark-test/tenant-x/" }),
      );
      const yList = await client.send(
        new sdk.ListObjectsV2Command({ Bucket: ls.bucket, Prefix: "ark-test/tenant-y/" }),
      );
      const xKeys = (xList.Contents ?? []).map((o) => o.Key ?? "");
      const yKeys = (yList.Contents ?? []).map((o) => o.Key ?? "");

      expect(xKeys.length).toBeGreaterThan(0);
      expect(yKeys.length).toBeGreaterThan(0);
      expect(xKeys.every((k) => k.startsWith("ark-test/tenant-x/"))).toBe(true);
      expect(yKeys.every((k) => k.startsWith("ark-test/tenant-y/"))).toBe(true);
      // Sanity: tenant-x's keys must not leak into tenant-y's listing and
      // vice versa.
      expect(xKeys.some((k) => k.includes("/tenant-y/"))).toBe(false);
      expect(yKeys.some((k) => k.includes("/tenant-x/"))).toBe(false);
    } finally {
      client.destroy();
    }
  });
});
