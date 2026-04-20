/**
 * S3BlobStore integration test.
 *
 * Skipped unless `ARK_S3_TEST_BUCKET` is set. Optional env vars:
 *   - ARK_S3_TEST_REGION  (default: us-east-1)
 *   - ARK_S3_TEST_PREFIX  (default: ark-test)
 *   - ARK_S3_TEST_ENDPOINT (for LocalStack / MinIO)
 *
 * To run locally against LocalStack:
 *
 *   docker run -d --rm -p 4566:4566 localstack/localstack
 *   aws --endpoint-url=http://localhost:4566 s3 mb s3://ark-blob-test
 *   ARK_S3_TEST_BUCKET=ark-blob-test \
 *   ARK_S3_TEST_ENDPOINT=http://localhost:4566 \
 *   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
 *     bun test packages/core/storage/__tests__/s3.test.ts
 *
 * CI doesn't set ARK_S3_TEST_BUCKET, so the entire suite is skipped by
 * default. No `aws-sdk-client-mock` is pulled in to keep this PR tight;
 * we rely on LocalStack for round-trip coverage.
 */

import { describe, it, expect, beforeAll } from "bun:test";
import { S3BlobStore } from "../s3.js";
import { LOCAL_TENANT_ID } from "../blob-store.js";

const bucket = process.env.ARK_S3_TEST_BUCKET;
const region = process.env.ARK_S3_TEST_REGION ?? "us-east-1";
const prefix = process.env.ARK_S3_TEST_PREFIX ?? "ark-test";
const endpoint = process.env.ARK_S3_TEST_ENDPOINT;

const maybe = bucket ? describe : describe.skip;

maybe("S3BlobStore (integration)", () => {
  let store: S3BlobStore;

  beforeAll(() => {
    store = new S3BlobStore({ bucket: bucket!, region, prefix, endpoint });
  });

  it("round-trips bytes through put + get", async () => {
    const bytes = Buffer.from("hello s3", "utf-8");
    const meta = await store.put(
      { tenantId: LOCAL_TENANT_ID, namespace: "inputs", id: `t-${Date.now()}`, filename: "s3.txt" },
      bytes,
      { contentType: "text/plain" },
    );
    expect(meta.locator).toBeTruthy();

    const out = await store.get(meta.locator, LOCAL_TENANT_ID);
    expect(out.bytes.toString("utf-8")).toBe("hello s3");
    expect(out.meta.filename).toBe("s3.txt");

    await store.delete(meta.locator, LOCAL_TENANT_ID);
  });

  it("rejects cross-tenant reads", async () => {
    const { locator } = await store.put(
      { tenantId: "tenant-a", namespace: "inputs", id: `t-${Date.now()}`, filename: "t.txt" },
      Buffer.from("secret"),
    );
    await expect(store.get(locator, "tenant-b")).rejects.toThrow(/tenant/i);
    await store.delete(locator, "tenant-a");
  });
});
