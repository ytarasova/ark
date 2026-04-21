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
import type { SecretRef, SecretsCapability } from "./types.js";
import { assertValidSecretName } from "./types.js";

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
}

/** SSM surfaces "not found" as either an error class name or an HTTP 400 with a typed error. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === "ParameterNotFound") return true;
  if (e.Code === "ParameterNotFound") return true;
  return false;
}
