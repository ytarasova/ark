/**
 * AWS SSM Parameter Store-backed secrets provider (control plane).
 *
 * Stores each secret as a `SecureString` parameter at
 * `/ark/<tenantId>/<NAME>`. AWS handles encryption via KMS (default alias
 * or an operator-supplied `awsKmsKeyId`) and the audit trail lives in
 * CloudTrail.
 *
 * There is intentionally NO fallback to `process.env`. Hosted mode must
 * be deliberate about where secrets come from so operators never end up
 * shipping env-baked values to every tenant by accident.
 */

import type { SSMClient } from "@aws-sdk/client-ssm";
import type { BlobRef, SecretRef, SecretType, SecretsCapability } from "./types.js";
import { assertValidSecretName, assertValidBlobName, assertValidBlobFilename } from "./types.js";
import { normalizeBlob, type BlobInput, type BlobBytes } from "./blob.js";

export interface AwsSecretsConfig {
  /** AWS region. Defaults to `process.env.AWS_REGION || "us-east-1"`. */
  region?: string;
  /** Optional override KMS key (alias/ARN/id). When unset, the account default alias is used. */
  kmsKeyId?: string;
  /** Test hook: inject a pre-built SSMClient. Normal code paths leave this unset. */
  client?: SSMClient;
}

const PATH_ROOT = "/ark";

function paramPath(tenantId: string, name: string): string {
  return `${PATH_ROOT}/${tenantId}/${name}`;
}

function tenantPrefix(tenantId: string): string {
  return `${PATH_ROOT}/${tenantId}/`;
}

function nameFromPath(path: string, tenantId: string): string | null {
  const prefix = tenantPrefix(tenantId);
  if (!path.startsWith(prefix)) return null;
  return path.slice(prefix.length);
}

/**
 * Blob layout under SSM:
 *   /ark/<tenant>/blobs/<blobName>/<file>
 *
 * Each file in a blob is stored as its own SecureString parameter. Listing
 * and deletion walk the prefix with `GetParametersByPath` / paginated
 * `DeleteParameters`. The `ark-blob-parent=<blobName>` tag isn't strictly
 * required for correctness (the prefix encodes the parent) but it's a
 * convenience knob for operators querying SSM directly.
 */
const BLOB_SEGMENT = "blobs";

function blobPrefix(tenantId: string): string {
  return `${PATH_ROOT}/${tenantId}/${BLOB_SEGMENT}/`;
}

function blobNamePrefix(tenantId: string, blobName: string): string {
  return `${PATH_ROOT}/${tenantId}/${BLOB_SEGMENT}/${blobName}/`;
}

function blobFilePath(tenantId: string, blobName: string, filename: string): string {
  return `${PATH_ROOT}/${tenantId}/${BLOB_SEGMENT}/${blobName}/${filename}`;
}

export class AwsSecretsProvider implements SecretsCapability {
  private readonly cfg: AwsSecretsConfig;
  private _client: SSMClient | null;

  constructor(cfg: AwsSecretsConfig = {}) {
    this.cfg = cfg;
    this._client = cfg.client ?? null;
  }

  /**
   * Lazily construct the SSM client. Dynamic-imported so local-mode boots
   * don't pay the @aws-sdk module load cost.
   */
  private async client(): Promise<SSMClient> {
    if (this._client) return this._client;
    const { SSMClient: Ctor } = await import("@aws-sdk/client-ssm");
    const region = this.cfg.region ?? process.env.AWS_REGION ?? "us-east-1";
    this._client = new Ctor({ region });
    return this._client;
  }

  async list(tenantId: string): Promise<SecretRef[]> {
    const { GetParametersByPathCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();
    const refs: SecretRef[] = [];
    let nextToken: string | undefined = undefined;
    do {
      const res: {
        Parameters?: Array<{ Name?: string; LastModifiedDate?: Date; Description?: string }>;
        NextToken?: string;
      } = await ssm.send(
        new GetParametersByPathCommand({
          Path: tenantPrefix(tenantId),
          Recursive: false,
          WithDecryption: false,
          NextToken: nextToken,
        }),
      );
      for (const p of res.Parameters ?? []) {
        if (!p.Name) continue;
        const n = nameFromPath(p.Name, tenantId);
        if (!n) continue;
        const updated = p.LastModifiedDate ? new Date(p.LastModifiedDate).toISOString() : new Date(0).toISOString();
        refs.push({
          tenant_id: tenantId,
          name: n,
          // Task 4 will decode the Description envelope to extract a real type
          // and metadata. Until then, back-fill safe defaults so callers that
          // read ref.type (e.g. placement code) never see undefined.
          type: "env-var",
          metadata: {},
          description: p.Description,
          // SSM doesn't track creation distinct from modification on parameters;
          // surface the same timestamp for both so the UI has something sensible.
          created_at: updated,
          updated_at: updated,
        });
      }
      nextToken = res.NextToken;
    } while (nextToken);
    refs.sort((a, b) => a.name.localeCompare(b.name));
    return refs;
  }

  async get(tenantId: string, name: string): Promise<string | null> {
    assertValidSecretName(name);
    const { GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();
    try {
      const res: { Parameter?: { Value?: string } } = await ssm.send(
        new GetParameterCommand({ Name: paramPath(tenantId, name), WithDecryption: true }),
      );
      return res.Parameter?.Value ?? null;
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async set(tenantId: string, name: string, value: string, opts?: { description?: string }): Promise<void> {
    assertValidSecretName(name);
    if (typeof value !== "string") throw new Error("Secret value must be a string");
    const { PutParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();
    await ssm.send(
      new PutParameterCommand({
        Name: paramPath(tenantId, name),
        Value: value,
        Type: "SecureString",
        Overwrite: true,
        Tier: "Standard",
        KeyId: this.cfg.kmsKeyId,
        Description: opts?.description,
      }),
    );
  }

  async delete(tenantId: string, name: string): Promise<boolean> {
    assertValidSecretName(name);
    const { DeleteParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();
    try {
      await ssm.send(new DeleteParameterCommand({ Name: paramPath(tenantId, name) }));
      return true;
    } catch (err: unknown) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async resolveMany(tenantId: string, names: string[]): Promise<Record<string, string>> {
    if (!Array.isArray(names) || names.length === 0) return {};
    for (const n of names) assertValidSecretName(n);
    const { GetParametersCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();
    // SSM caps GetParameters at 10 names per call; page the batches.
    const out: Record<string, string> = {};
    const missing = new Set<string>(names);
    for (let i = 0; i < names.length; i += 10) {
      const batch = names.slice(i, i + 10);
      const paths = batch.map((n) => paramPath(tenantId, n));
      const res: { Parameters?: Array<{ Name?: string; Value?: string }>; InvalidParameters?: string[] } =
        await ssm.send(new GetParametersCommand({ Names: paths, WithDecryption: true }));
      for (const p of res.Parameters ?? []) {
        const n = p.Name ? nameFromPath(p.Name, tenantId) : null;
        if (n && typeof p.Value === "string") {
          out[n] = p.Value;
          missing.delete(n);
        }
      }
    }
    if (missing.size > 0) {
      const list = Array.from(missing).sort();
      throw new Error(`Missing secrets for tenant '${tenantId}': ${list.join(", ")}`);
    }
    return out;
  }

  // ── Blob surface (multi-file secrets) ──────────────────────────────────
  //
  // Each file in a blob is a distinct SSM SecureString parameter under
  //   /ark/<tenant>/blobs/<blobName>/<file>
  // The values are base64-encoded because SSM parameters are strings only
  // and credential blobs may eventually contain non-UTF-8 bytes. On the
  // read side we decode back to Uint8Array before returning. Keeping the
  // wire format opaque makes dispatch-time code (which materializes a k8s
  // Secret) agnostic of how each backend stored the files.

  private async listBlobParamsByParent(
    tenantId: string,
    parent: string,
  ): Promise<Array<{ Name: string; Value?: string }>> {
    const { GetParametersByPathCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();
    const out: Array<{ Name: string; Value?: string }> = [];
    let nextToken: string | undefined = undefined;
    do {
      const res: {
        Parameters?: Array<{ Name?: string; Value?: string }>;
        NextToken?: string;
      } = await ssm.send(
        new GetParametersByPathCommand({
          Path: blobNamePrefix(tenantId, parent),
          Recursive: true,
          WithDecryption: true,
          NextToken: nextToken,
        }),
      );
      for (const p of res.Parameters ?? []) {
        if (p.Name) out.push({ Name: p.Name, Value: p.Value });
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return out;
  }

  async listBlobs(tenantId: string): Promise<string[]> {
    return (await this.listBlobsDetailed(tenantId)).map((r) => r.name);
  }

  async listBlobsDetailed(tenantId: string): Promise<BlobRef[]> {
    const { GetParametersByPathCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();
    const prefix = blobPrefix(tenantId);
    const names = new Set<string>();
    let nextToken: string | undefined = undefined;
    do {
      const res: {
        Parameters?: Array<{ Name?: string }>;
        NextToken?: string;
      } = await ssm.send(
        new GetParametersByPathCommand({
          Path: prefix,
          Recursive: true,
          WithDecryption: false,
          NextToken: nextToken,
        }),
      );
      for (const p of res.Parameters ?? []) {
        if (!p.Name) continue;
        if (!p.Name.startsWith(prefix)) continue;
        const rest = p.Name.slice(prefix.length);
        const firstSlash = rest.indexOf("/");
        if (firstSlash <= 0) continue;
        names.add(rest.slice(0, firstSlash));
      }
      nextToken = res.NextToken;
    } while (nextToken);
    // TODO(Task 4): Persist + read type/metadata via the SSM Description JSON envelope.
    // - Source of truth: the per-blob "manifest" parameter (we currently write
    //   one Description per file -- pick one canonical "manifest" file by sort
    //   order, or introduce a dedicated `<prefix>/.meta` parameter, OR encode
    //   the envelope on every file's Description).
    // - Envelope format: encodeDescriptionEnvelope({type, metadata}) (Task 4
    //   adds this helper). decodeDescriptionEnvelope tolerates legacy plain
    //   strings and missing fields.
    // - SSM Description max length: 1024 chars. JSON envelope must fit.
    // - created_at / updated_at: derived from SSM LastModifiedDate via
    //   DescribeParameters (already used elsewhere in this file).
    // For now return safe defaults so callers that read ref.type never see
    // undefined. The envelope encode/decode lands in Task 4.
    const epoch = new Date(0).toISOString();
    return Array.from(names)
      .sort()
      .map((name) => ({
        tenant_id: tenantId,
        name,
        type: "generic-blob" as const,
        metadata: {},
        created_at: epoch,
        updated_at: epoch,
      }));
  }

  async getBlob(tenantId: string, name: string): Promise<Record<string, Uint8Array> | null> {
    assertValidBlobName(name);
    const params = await this.listBlobParamsByParent(tenantId, name);
    if (params.length === 0) return null;
    const prefix = blobNamePrefix(tenantId, name);
    const out: BlobBytes = {};
    for (const p of params) {
      if (!p.Name.startsWith(prefix)) continue;
      const filename = p.Name.slice(prefix.length);
      try {
        assertValidBlobFilename(filename);
      } catch {
        continue;
      }
      if (typeof p.Value !== "string") continue;
      try {
        const raw = Buffer.from(p.Value, "base64");
        out[filename] = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } catch {
        // Skip unreadable entries rather than fail the whole read; caller
        // sees a partial blob which is better than no blob at all.
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  // TODO(Task 4): Persist + read type/metadata via the SSM Description JSON envelope.
  // - Source of truth: the per-blob "manifest" parameter (we currently write
  //   one Description per file -- pick one canonical "manifest" file by sort
  //   order, or introduce a dedicated `<prefix>/.meta` parameter, OR encode
  //   the envelope on every file's Description).
  // - Envelope format: encodeDescriptionEnvelope({type, metadata}) (Task 4
  //   adds this helper). decodeDescriptionEnvelope tolerates legacy plain
  //   strings and missing fields.
  // - SSM Description max length: 1024 chars. JSON envelope must fit.
  // - created_at / updated_at: derived from SSM LastModifiedDate via
  //   DescribeParameters (already used elsewhere in this file).
  async setBlob(
    tenantId: string,
    name: string,
    files: BlobInput,
    _opts?: { type?: SecretType; metadata?: Record<string, string> },
  ): Promise<void> {
    assertValidBlobName(name);
    const normalized = normalizeBlob(files);
    const { PutParameterCommand, DeleteParametersCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();

    // Delete any files from the previous blob that are no longer present.
    // setBlob is create-or-replace, not merge.
    const existing = await this.listBlobParamsByParent(tenantId, name);
    const keepPaths = new Set(Object.keys(normalized).map((f) => blobFilePath(tenantId, name, f)));
    const toDelete = existing.filter((p) => !keepPaths.has(p.Name)).map((p) => p.Name);
    // DeleteParameters caps at 10 names per call.
    for (let i = 0; i < toDelete.length; i += 10) {
      const batch = toDelete.slice(i, i + 10);
      if (batch.length === 0) continue;
      try {
        await ssm.send(new DeleteParametersCommand({ Names: batch }));
      } catch {
        // best-effort; the overwrite below still writes the new blob.
      }
    }

    for (const filename of Object.keys(normalized)) {
      const value = Buffer.from(normalized[filename]).toString("base64");
      // SSM's PutParameter rejects `Tags` when `Overwrite: true`. We tag
      // on first create and skip on subsequent updates -- a harmless
      // no-op for an already-tagged parameter, and the tag is there for
      // operator-side discovery (`aws ssm list-tags-for-resource`).
      const paramPathName = blobFilePath(tenantId, name, filename);
      const existed = existing.some((p) => p.Name === paramPathName);
      await ssm.send(
        new PutParameterCommand({
          Name: paramPathName,
          Value: value,
          Type: "SecureString",
          Overwrite: true,
          Tier: "Standard",
          KeyId: this.cfg.kmsKeyId,
          Description: `ark blob ${name} file ${filename}`,
          ...(existed ? {} : { Tags: [{ Key: "ark-blob-parent", Value: name }] }),
        }),
      );
    }
  }

  async deleteBlob(tenantId: string, name: string): Promise<boolean> {
    assertValidBlobName(name);
    const { DeleteParametersCommand } = await import("@aws-sdk/client-ssm");
    const ssm = await this.client();
    const existing = await this.listBlobParamsByParent(tenantId, name);
    if (existing.length === 0) return false;
    const paths = existing.map((p) => p.Name);
    for (let i = 0; i < paths.length; i += 10) {
      const batch = paths.slice(i, i + 10);
      try {
        await ssm.send(new DeleteParametersCommand({ Names: batch }));
      } catch {
        // best-effort -- partial delete is still better than no delete.
      }
    }
    return true;
  }
}

/** SSM surfaces "not found" as either an error class name or an HTTP 400 with a typed error. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === "ParameterNotFound") return true;
  if (e.Code === "ParameterNotFound") return true;
  return false;
}
