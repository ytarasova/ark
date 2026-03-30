/**
 * SSH, rsync, and key-generation primitives for EC2 hosts.
 * ALL operations are async — no sync exec calls.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { poll } from "../../util.js";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const execFileAsync = promisify(execFile);

export const SSH_OPTS: string[] = [
  "-o", "StrictHostKeyChecking=no",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=10",
  "-o", "ServerAliveCountMax=3",
  "-o", "LogLevel=ERROR",
];

/** Return the path to the SSH private key for a given host name. */
export function sshKeyPath(hostName: string): string {
  return join(homedir(), ".ssh", `ark-${hostName}`);
}

/** Build base SSH command arguments with optional port forwards. */
export function sshBaseArgs(key: string, ip: string, ports?: number[]): string[] {
  const args = ["ssh", "-i", key, ...SSH_OPTS];
  for (const p of ports ?? []) {
    args.push("-L", `${p}:localhost:${p}`);
  }
  args.push(`ubuntu@${ip}`);
  return args;
}

/**
 * Execute a command on a remote host via SSH (async).
 * Never throws. Returns stdout, stderr, and exitCode.
 */
export async function sshExec(
  key: string,
  ip: string,
  cmd: string,
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = sshBaseArgs(key, ip);
  const [bin, ...rest] = args;
  rest.push(cmd);

  try {
    const { stdout } = await execFileAsync(bin, rest, {
      encoding: "utf-8",
      timeout: opts?.timeout ?? 30_000,
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      exitCode: typeof err.status === "number" ? err.status : 1,
    };
  }
}

/** Alias for backward compatibility */
export const sshExecAsync = sshExec;

// ---------------------------------------------------------------------------
// rsync helpers
// ---------------------------------------------------------------------------

function rsyncSshOpt(key: string): string {
  return `ssh -i ${key} -o StrictHostKeyChecking=no -o ConnectTimeout=10`;
}

/** Build rsync arguments for pushing local -> remote. */
export function rsyncPushArgs(key: string, ip: string, local: string, remote: string): string[] {
  return [
    "rsync", "-avz", "--update", "--timeout=15",
    "-e", rsyncSshOpt(key),
    local, `ubuntu@${ip}:${remote}`,
  ];
}

/** Build rsync arguments for pulling remote -> local. */
export function rsyncPullArgs(key: string, ip: string, remote: string, local: string): string[] {
  return [
    "rsync", "-avz", "--update", "--timeout=15",
    "-e", rsyncSshOpt(key),
    `ubuntu@${ip}:${remote}`, local,
  ];
}

/** Push local path to remote via rsync (async). */
export async function rsyncPush(key: string, ip: string, local: string, remote: string): Promise<void> {
  const [bin, ...rest] = rsyncPushArgs(key, ip, local, remote);
  try {
    await execFileAsync(bin, rest, { encoding: "utf-8", timeout: 300_000 });
  } catch (e: any) {
    console.error(`rsyncPush failed (${local} -> ${ip}:${remote}):`, e?.message ?? e);
  }
}

/** Pull remote path to local via rsync (async). */
export async function rsyncPull(key: string, ip: string, remote: string, local: string): Promise<void> {
  const [bin, ...rest] = rsyncPullArgs(key, ip, remote, local);
  try {
    await execFileAsync(bin, rest, { encoding: "utf-8", timeout: 300_000 });
  } catch (e: any) {
    console.error(`rsyncPull failed (${ip}:${remote} -> ${local}):`, e?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// Connectivity & key management
// ---------------------------------------------------------------------------

/**
 * Poll SSH readiness (async).
 * Returns true as soon as a connection succeeds.
 */
export async function waitForSsh(key: string, ip: string, maxAttempts = 30): Promise<boolean> {
  return poll(
    async () => {
      const { exitCode } = await sshExec(key, ip, "echo ok", { timeout: 10_000 });
      return exitCode === 0;
    },
    { maxAttempts, delayMs: 5000 },
  );
}

/** Alias for backward compatibility */
export const waitForSshAsync = waitForSsh;

/**
 * Generate an ed25519 SSH key pair (async).
 */
export async function generateSshKey(hostName: string): Promise<{ publicKeyPath: string; privateKeyPath: string }> {
  const privateKeyPath = sshKeyPath(hostName);
  const publicKeyPath = `${privateKeyPath}.pub`;

  if (existsSync(privateKeyPath)) {
    return { publicKeyPath, privateKeyPath };
  }

  const dir = join(privateKeyPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    await execFileAsync("ssh-keygen", [
      "-t", "ed25519",
      "-f", privateKeyPath,
      "-N", "",
      "-C", `ark-${hostName}`,
    ], { encoding: "utf-8" });
  } catch (err: any) {
    throw new Error(`Failed to generate SSH key: ${err.stderr ?? err.message}`);
  }

  return { publicKeyPath, privateKeyPath };
}
