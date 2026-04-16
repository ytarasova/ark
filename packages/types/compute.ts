export type ComputeStatus = "stopped" | "running" | "provisioning" | "destroyed";
export type ComputeProviderName = "local" | "docker" | "ec2" | "remote-arkd";

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
  provider: ComputeProviderName;
  status: ComputeStatus;
  config: ComputeConfig;
  created_at: string;
  updated_at: string;
}

export interface CreateComputeOpts {
  name: string;
  provider?: ComputeProviderName;
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
