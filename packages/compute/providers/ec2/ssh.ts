/**
 * SSH, rsync, and key-generation primitives for EC2 hosts.
 * Ported from BigBox's Python ssh.py to TypeScript.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
 * Execute a command on a remote host via SSH.
 * Uses execFileSync; never throws. Returns stdout, stderr, and exitCode.
 */
export function sshExec(
  key: string,
  ip: string,
  cmd: string,
  opts?: { timeout?: number },
): { stdout: string; stderr: string; exitCode: number } {
  const args = sshBaseArgs(key, ip);
  // First element is "ssh" — that's the binary, rest are args.
  const [bin, ...rest] = args;
  rest.push(cmd);

  try {
    const stdout = execFileSync(bin, rest, {
      encoding: "utf-8",
      timeout: opts?.timeout ?? 30_000,
      stdio: ["pipe", "pipe", "pipe"],
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

/** Push local path to remote via rsync. */
export function rsyncPush(key: string, ip: string, local: string, remote: string): void {
  const [bin, ...rest] = rsyncPushArgs(key, ip, local, remote);
  try {
    execFileSync(bin, rest, { encoding: "utf-8", timeout: 300_000, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    // best-effort — caller may retry
  }
}

/** Pull remote path to local via rsync. */
export function rsyncPull(key: string, ip: string, remote: string, local: string): void {
  const [bin, ...rest] = rsyncPullArgs(key, ip, remote, local);
  try {
    execFileSync(bin, rest, { encoding: "utf-8", timeout: 300_000, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    // best-effort — caller may retry
  }
}

// ---------------------------------------------------------------------------
// Connectivity & key management
// ---------------------------------------------------------------------------

/**
 * Poll SSH readiness with 5 s sleep between attempts.
 * Returns true as soon as a connection succeeds.
 */
export function waitForSsh(key: string, ip: string, maxAttempts = 30): boolean {
  for (let i = 0; i < maxAttempts; i++) {
    const { exitCode } = sshExec(key, ip, "echo ok", { timeout: 10_000 });
    if (exitCode === 0) return true;
    if (i < maxAttempts - 1) {
      execFileSync("sleep", ["5"]);
    }
  }
  return false;
}

/**
 * Generate an ed25519 SSH key pair at sshKeyPath(hostName) if it does not
 * already exist. Returns the public and private key paths.
 */
export function generateSshKey(hostName: string): { publicKeyPath: string; privateKeyPath: string } {
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
    execFileSync("ssh-keygen", [
      "-t", "ed25519",
      "-f", privateKeyPath,
      "-N", "",
      "-C", `ark-${hostName}`,
    ], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  } catch (err: any) {
    throw new Error(`Failed to generate SSH key: ${err.stderr ?? err.message}`);
  }

  return { publicKeyPath, privateKeyPath };
}
