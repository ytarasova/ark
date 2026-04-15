/**
 * Shared Docker container helpers used by both DockerProvider and LocalDockerProvider.
 *
 * Centralizes image pulling, container creation, and container starting
 * so the logic does not drift between the two provider implementations.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";

const execFileAsync = promisify(execFile);

const DEFAULT_IMAGE = "ubuntu:22.04";

/** Pull a Docker image with a generous timeout for large images. */
export async function pullImage(image: string): Promise<void> {
  await execFileAsync("docker", ["pull", image], { timeout: 300_000 });
}

/**
 * Create a persistent Docker container with standard credential mounts.
 * Mounts ~/.ssh, ~/.claude (read-only), and optionally ~/.aws.
 */
export async function createContainer(name: string, image: string, extraVolumes: string[] = []): Promise<void> {
  const home = homedir();
  const createArgs = [
    "create",
    "--name",
    name,
    "-it",
    "-v",
    `${join(home, ".ssh")}:/root/.ssh:ro`,
    "-v",
    `${join(home, ".claude")}:/root/.claude:ro`,
  ];

  const awsDir = join(home, ".aws");
  if (existsSync(awsDir)) {
    createArgs.push("-v", `${awsDir}:/root/.aws:ro`);
  }

  for (const vol of extraVolumes) {
    createArgs.push("-v", vol);
  }

  createArgs.push(image, "bash");
  await execFileAsync("docker", createArgs, { timeout: 30_000 });
}

/** Start an existing Docker container. */
export async function startContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["start", name], { timeout: 15_000 });
}

/** Stop a Docker container. */
export async function stopContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["stop", name], { timeout: 15_000 });
}

/** Remove a Docker container forcefully. */
export async function removeContainer(name: string): Promise<void> {
  await execFileAsync("docker", ["rm", "-f", name], { timeout: 15_000 });
}

export { DEFAULT_IMAGE };
