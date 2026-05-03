import type { SecretType } from "./types.js";

/** Resolved typed secret -- name + type + metadata + the bytes/value to place. */
export interface TypedSecret {
  name: string;
  type: SecretType;
  metadata: Record<string, string>;
  /** For string-shaped secrets (env-var, ssh-private-key, kubeconfig). */
  value?: string;
  /** For blob-shaped secrets (generic-blob). */
  files?: Record<string, Uint8Array>;
}

/**
 * Verb-based contract a provider implements once. Placers call into these
 * verbs and never see the medium (SSM-via-arkd, k8s API, fs, etc.).
 */
export interface PlacementCtx {
  /** Write a file on the target. Mode is bit-exact (placer chooses). */
  writeFile(path: string, mode: number, bytes: Uint8Array): Promise<void>;

  /** Append a marker-keyed block to a file, replacing any prior block with the same marker. */
  appendFile(path: string, marker: string, bytes: Uint8Array): Promise<void>;

  /** Set an env var that lands on the agent launcher. Synchronous. */
  setEnv(key: string, value: string): void;

  /** Configure the provisioner itself (k8s consumes kubeconfig; others ignore). */
  setProvisionerConfig(cfg: { kubeconfig?: Uint8Array }): void;

  /** Expand "~/foo" to the medium's actual home, e.g. /home/ubuntu/foo on EC2. */
  expandHome(rel: string): string;

  /** After placement, returns accumulated env for the launcher. */
  getEnv(): Record<string, string>;
}

/** A placer for one secret type. */
export interface TypedSecretPlacer {
  /** Type this placer handles. */
  readonly type: SecretType;

  /** Place the secret onto the target via the provider's ctx. */
  place(secret: TypedSecret, ctx: PlacementCtx): Promise<void>;
}

/** Thrown when required metadata is missing on a typed secret. */
export class RequiredMetadataMissing extends Error {
  constructor(
    public readonly secretName: string,
    public readonly missing: string[],
  ) {
    super(`Secret '${secretName}' is missing required metadata: ${missing.join(", ")}`);
    this.name = "RequiredMetadataMissing";
  }
}

export function requireMetadata(secret: TypedSecret, keys: string[]): void {
  const missing = keys.filter((k) => !secret.metadata[k]);
  if (missing.length) throw new RequiredMetadataMissing(secret.name, missing);
}
