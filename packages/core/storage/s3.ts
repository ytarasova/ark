/**
 * S3BlobStore -- AWS S3-backed BlobStore for hosted (control-plane) deployments.
 *
 * Key layout: `{prefix}/{tenantId}/{namespace}/{id}/{filename}` where
 * `prefix` defaults to `"ark"`. Credentials resolve through the AWS SDK's
 * default provider chain (env vars, shared config, IMDS, SSO, ...).
 *
 * This PR intentionally leaves presigned URLs, server-side encryption
 * config, and multipart uploads out of scope. The 50 MiB cap enforced by
 * the BlobStore interface keeps us under the single-request PUT ceiling.
 */

import type { S3Client, PutObjectCommandInput, GetObjectCommandInput } from "@aws-sdk/client-s3";
import {
  type BlobStore,
  type BlobKey,
  type BlobMeta,
  type PutOptions,
  DEFAULT_MAX_BYTES,
  encodeLocator,
  assertTenantMatch,
} from "./blob-store.js";

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  /** Optional prefix under the bucket root. Default: "ark". */
  prefix?: string;
  /** Override endpoint for LocalStack / MinIO. */
  endpoint?: string;
  /**
   * Pre-built S3 client (for test harnesses such as aws-sdk-client-mock).
   * When omitted, the store lazily constructs one from `region` + `endpoint`.
   */
  client?: S3Client;
}

export class S3BlobStore implements BlobStore {
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly region: string;
  private readonly endpoint?: string;
  private _client: S3Client | null;
  private _sdk: typeof import("@aws-sdk/client-s3") | null = null;

  constructor(opts: S3BlobStoreOptions) {
    if (!opts.bucket) throw new Error("S3BlobStore: bucket is required");
    if (!opts.region) throw new Error("S3BlobStore: region is required");
    this.bucket = opts.bucket;
    this.region = opts.region;
    this.prefix = opts.prefix ?? "ark";
    this.endpoint = opts.endpoint;
    this._client = opts.client ?? null;
  }

  async put(key: BlobKey, bytes: Buffer, opts: PutOptions = {}): Promise<BlobMeta> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (bytes.length > maxBytes) {
      throw new Error(`Blob exceeds maxBytes (${bytes.length} > ${maxBytes})`);
    }
    const { client, sdk } = await this.ensureClient();
    const params: PutObjectCommandInput = {
      Bucket: this.bucket,
      Key: this.s3KeyFor(key),
      Body: bytes,
      ContentLength: bytes.length,
      ContentType: opts.contentType,
    };
    await client.send(new sdk.PutObjectCommand(params));
    return {
      locator: encodeLocator(key),
      filename: key.filename,
      size: bytes.length,
      contentType: opts.contentType,
      createdAt: new Date().toISOString(),
    };
  }

  async get(locator: string, requestingTenantId: string): Promise<{ bytes: Buffer; meta: BlobMeta }> {
    const key = assertTenantMatch(locator, requestingTenantId);
    const { client, sdk } = await this.ensureClient();
    const params: GetObjectCommandInput = {
      Bucket: this.bucket,
      Key: this.s3KeyFor(key),
    };
    const res = await client.send(new sdk.GetObjectCommand(params));
    const bytes = await streamToBuffer(res.Body);
    return {
      bytes,
      meta: {
        locator,
        filename: key.filename,
        size: res.ContentLength ?? bytes.length,
        contentType: res.ContentType,
        createdAt: res.LastModified?.toISOString() ?? new Date().toISOString(),
      },
    };
  }

  async delete(locator: string, requestingTenantId: string): Promise<void> {
    const key = assertTenantMatch(locator, requestingTenantId);
    const { client, sdk } = await this.ensureClient();
    await client.send(
      new sdk.DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.s3KeyFor(key),
      }),
    );
  }

  async dispose(): Promise<void> {
    // S3Client.destroy() is synchronous on v3 but keep this async for the
    // interface contract + future-proofing.
    this._client?.destroy();
    this._client = null;
  }

  private s3KeyFor(key: BlobKey): string {
    return [this.prefix, key.tenantId, key.namespace, key.id, key.filename].join("/");
  }

  private async ensureClient(): Promise<{ client: S3Client; sdk: typeof import("@aws-sdk/client-s3") }> {
    const sdk = this._sdk ?? (await import("@aws-sdk/client-s3"));
    this._sdk = sdk;
    if (!this._client) {
      this._client = new sdk.S3Client({
        region: this.region,
        endpoint: this.endpoint,
        // forcePathStyle keeps LocalStack / MinIO happy without bucket DNS.
        forcePathStyle: this.endpoint !== undefined,
      });
    }
    return { client: this._client, sdk };
  }
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  // Node Readable streams have `.transformToByteArray()` in the SDK v3.
  const anyBody = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof anyBody.transformToByteArray === "function") {
    return Buffer.from(await anyBody.transformToByteArray());
  }
  // Fallback for test doubles returning raw buffers / strings.
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf-8");
  // Last resort: async iterator.
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
