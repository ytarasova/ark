/**
 * Docker sandbox mode — run sessions in isolated containers.
 * Project directory is bind-mounted RW, system is protected.
 */

import { execSync } from "child_process";

export interface SandboxConfig {
  image?: string;       // Docker image (default: "ubuntu:22.04")
  cpuLimit?: string;    // CPU limit (e.g., "2.0")
  memoryLimit?: string; // Memory limit (e.g., "4g")
  mountSsh?: boolean;   // Mount ~/.ssh read-only
  extraVolumes?: string[];
  env?: Record<string, string>;
}

const DEFAULT_IMAGE = "ubuntu:22.04";

/** Build docker run command for a sandboxed session. */
export function buildSandboxCommand(
  projectDir: string,
  innerCommand: string,
  config?: SandboxConfig,
): string {
  const image = config?.image ?? DEFAULT_IMAGE;
  const parts = ["docker", "run", "--rm", "-it"];

  // Bind mount project
  parts.push("-v", `${projectDir}:/workspace`);
  parts.push("-w", "/workspace");

  // Resource limits
  if (config?.cpuLimit) parts.push("--cpus", config.cpuLimit);
  if (config?.memoryLimit) parts.push("-m", config.memoryLimit);

  // SSH mount
  if (config?.mountSsh) {
    const home = process.env.HOME ?? "/root";
    parts.push("-v", `${home}/.ssh:/root/.ssh:ro`);
  }

  // Extra volumes
  for (const vol of config?.extraVolumes ?? []) {
    parts.push("-v", vol);
  }

  // Environment
  for (const [k, v] of Object.entries(config?.env ?? {})) {
    parts.push("-e", `${k}=${v}`);
  }

  parts.push(image);
  parts.push("bash", "-c", innerCommand);

  return parts.join(" ");
}

/** Check if Docker is available. */
export function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** List running sandbox containers. */
export function listSandboxContainers(): string[] {
  try {
    const output = execSync('docker ps --filter "label=ark-sandbox=true" --format "{{.Names}}"', {
      encoding: "utf-8",
      timeout: 5000,
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
