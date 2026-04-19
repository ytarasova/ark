export type ComputeStatus = "stopped" | "running" | "provisioning" | "destroyed";
export type ComputeProviderName = "local" | "docker" | "ec2" | "remote-arkd";

/**
 * Where the compute lives. Mirrors `ComputeKind` in packages/compute/core/types.ts
 * (duplicated here as a string union to avoid a cross-package import cycle).
 */
export type ComputeKindName = "local" | "firecracker" | "ec2" | "k8s" | "k8s-kata";

/**
 * How the agent process is launched inside the compute. Mirrors `RuntimeKind`.
 */
export type RuntimeKindName = "direct" | "docker" | "compose" | "devcontainer" | "firecracker-in-container";

export interface LocalComputeConfig {
  [key: string]: unknown;
}

export interface EC2ComputeConfig {
  ip?: string;
  key_path?: string;
  instance_id?: string;
  size?: string;
  region?: string;
  ami?: string;
  ssh_user?: string;
  [key: string]: unknown;
}

export interface DockerComputeConfig {
  image?: string;
  container_id?: string;
  [key: string]: unknown;
}

export interface RemoteArkdConfig {
  ip?: string;
  key_path?: string;
  ssh_user?: string;
  arkd_port?: number;
  [key: string]: unknown;
}

export type ComputeConfig = LocalComputeConfig | EC2ComputeConfig | DockerComputeConfig | RemoteArkdConfig;

export interface Compute {
  name: string;
  /** @deprecated Use `compute_kind` + `runtime_kind`. Kept for back-compat reads. */
  provider: ComputeProviderName;
  /** Where the compute lives (Wave 3 dispatch axis). */
  compute_kind: ComputeKindName;
  /** How the agent process is launched (Wave 3 dispatch axis). */
  runtime_kind: RuntimeKindName;
  status: ComputeStatus;
  config: ComputeConfig;
  created_at: string;
  updated_at: string;
}

export interface CreateComputeOpts {
  name: string;
  /** @deprecated Use `compute` + `runtime`. Accepted for back-compat. */
  provider?: ComputeProviderName;
  /** Wave 3: compute axis (e.g. "local", "ec2"). */
  compute?: ComputeKindName;
  /** Wave 3: runtime axis (e.g. "direct", "docker"). */
  runtime?: RuntimeKindName;
  config?: Partial<ComputeConfig>;
  /** Apply a named template's defaults before user config overrides. */
  template?: string;
}

/**
 * A reusable compute configuration preset.
 * Stored in config.yaml (local) or DB (control plane).
 */
export interface ComputeTemplate {
  /** Unique template name (e.g. "gpu-large", "sandbox", "quick"). */
  name: string;
  /** Human-readable description. */
  description?: string;
  /** Target provider. */
  provider: ComputeProviderName;
  /** Provider-specific config defaults. */
  config: Partial<ComputeConfig>;
  /** Tenant that owns this template (control plane only). */
  tenant_id?: string;
}
