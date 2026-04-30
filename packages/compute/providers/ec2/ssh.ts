/**
 * SSH, rsync, and key-generation primitives for EC2 hosts.
 *
 * Transport: every SSH/rsync invocation is tunneled through AWS SSM Session
 * Manager via OpenSSH's `-o ProxyCommand=...`. The host argument is the EC2
 * `instance-id` (e.g. `i-0abc...`); SSH still authenticates with the
 * generated keypair, but TCP connectivity is provided by SSM rather than
 * direct network reachability. This means:
 *
 *   - No public IP is required on the instance.
 *   - No security-group ingress rule for port 22 is required.
 *   - The corp VPN / inspection appliances can no longer reset the SSH
 *     handshake -- the only outbound traffic is HTTPS to ssm.<region>.
 *
 * Callers pass `region` (and optional `awsProfile`) via the new opts param
 * on every helper. Nothing about the on-the-wire SSH/rsync semantics
 * changes -- ControlMaster, port forwarding, tar pipes, etc. all keep
 * working through the SSM tunnel.
 *
 * ALL operations are async -- no sync exec calls.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { poll } from "../../util.js";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { shellEscape } from "./shell-escape.js";
import { REMOTE_USER } from "./constants.js";

const execFileAsync = promisify(execFile);

export const SSH_OPTS: string[] = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "LogLevel=ERROR",
];

/**
 * Per-call AWS context needed to build the SSM ProxyCommand.
 *
 * `region` is required (SSM is region-scoped). `awsProfile` is optional --
 * when omitted, the AWS CLI uses its default credential chain (env vars,
 * default profile, instance role, etc.).
 */
export interface SsmConnectOpts {
  region: string;
  awsProfile?: string;
}

/** Default region used when a caller doesn't have one to thread through. */
const DEFAULT_REGION = "us-east-1";

/** Return the path to the SSH private key for a given host name. */
export function sshKeyPath(hostName: string): string {
  return join(homedir(), ".ssh", `ark-${hostName}`);
}

/**
 * Build the `-o ProxyCommand=...` arg pair that wraps the SSH connection in
 * an SSM Session Manager tunnel.
 *
 * The AWS-StartSSHSession document forwards the SSH protocol over SSM. SSH
 * substitutes `%h` (host arg, i.e. instance-id) and `%p` (port, 22).
 */
export function buildSsmProxyArgs(opts: SsmConnectOpts): string[] {
  const profilePart = opts.awsProfile ? ` --profile ${opts.awsProfile}` : "";
  const proxy =
    `aws ssm start-session --target %h ` +
    `--document-name AWS-StartSSHSession ` +
    `--parameters portNumber=%p ` +
    `--region ${opts.region}${profilePart}`;
  return ["-o", `ProxyCommand=${proxy}`];
}

/** Build base SSH command arguments with optional port forwards. */
export function sshBaseArgs(key: string, instanceId: string, opts: SsmConnectOpts, ports?: number[]): string[] {
  const args = ["ssh", "-i", key, ...SSH_OPTS, ...buildSsmProxyArgs(opts)];
  for (const p of ports ?? []) {
    args.push("-L", `${p}:localhost:${p}`);
  }
  args.push(`${REMOTE_USER}@${instanceId}`);
  return args;
}

/** Options accepted by sshExec / sshExecArgs / waitForSsh. */
export interface SshExecOpts extends Partial<SsmConnectOpts> {
  timeout?: number;
}

function resolveSsm(opts?: SshExecOpts): SsmConnectOpts {
  return { region: opts?.region ?? DEFAULT_REGION, awsProfile: opts?.awsProfile };
}

/**
 * Execute a command on a remote host via SSH-over-SSM (async).
 * Never throws. Returns stdout, stderr, and exitCode.
 */
export async function sshExec(
  key: string,
  instanceId: string,
  cmd: string,
  opts?: SshExecOpts,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const args = sshBaseArgs(key, instanceId, resolveSsm(opts));
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

/**
 * Execute a remote command from an argv array, shell-escaping each argument.
 *
 * Prefer this over `sshExec(key, id, `... ${var} ...`)` whenever any element
 * is derived from user input (session id, tenant id, workdir, attachment
 * name, repo path, etc.). SSH passes a single string to the remote shell,
 * so every interpolated value MUST be single-quote escaped first or a value
 * like `'; rm -rf /` will shell-expand on the remote.
 *
 * Example:
 *   sshExecArgs(key, id, ["mkdir", "-p", remoteDir], { region })
 * is equivalent to `sshExec(key, id, `mkdir -p ${shellEscape(remoteDir)}`, { region })`
 * -- but without the template-string footgun.
 */
export async function sshExecArgs(
  key: string,
  instanceId: string,
  argv: string[],
  opts?: SshExecOpts,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("sshExecArgs: argv must be a non-empty array");
  }
  const escaped = argv.map((a) => {
    if (typeof a !== "string") {
      throw new Error(`sshExecArgs: argv elements must be strings, got ${typeof a}`);
    }
    return shellEscape(a);
  });
  return sshExec(key, instanceId, escaped.join(" "), opts);
}

// ---------------------------------------------------------------------------
// rsync helpers
// ---------------------------------------------------------------------------

function rsyncSshOpt(key: string, ssm: SsmConnectOpts): string {
  const profilePart = ssm.awsProfile ? ` --profile ${ssm.awsProfile}` : "";
  // rsync's -e takes a single shell-quoted string, so the inner ProxyCommand
  // gets wrapped in double quotes. AWS CLI args have no shell metacharacters
  // beyond the single percent-substitutions SSH expands itself.
  const proxy =
    `aws ssm start-session --target %h ` +
    `--document-name AWS-StartSSHSession ` +
    `--parameters portNumber=%p ` +
    `--region ${ssm.region}${profilePart}`;
  return `ssh -i ${key} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o "ProxyCommand=${proxy}"`;
}

/** Build rsync arguments for pushing local -> remote. */
export function rsyncPushArgs(
  key: string,
  instanceId: string,
  local: string,
  remote: string,
  opts?: Partial<SsmConnectOpts>,
): string[] {
  return [
    "rsync",
    "-avz",
    "--update",
    "--timeout=30",
    "-e",
    rsyncSshOpt(key, resolveSsm(opts)),
    local,
    `${REMOTE_USER}@${instanceId}:${remote}`,
  ];
}

/** Build rsync arguments for pulling remote -> local. */
export function rsyncPullArgs(
  key: string,
  instanceId: string,
  remote: string,
  local: string,
  opts?: Partial<SsmConnectOpts>,
): string[] {
  return [
    "rsync",
    "-avz",
    "--update",
    "--timeout=30",
    "-e",
    rsyncSshOpt(key, resolveSsm(opts)),
    `${REMOTE_USER}@${instanceId}:${remote}`,
    local,
  ];
}

/** Push local path to remote via rsync (async). */
export async function rsyncPush(
  key: string,
  instanceId: string,
  local: string,
  remote: string,
  opts?: Partial<SsmConnectOpts>,
): Promise<void> {
  const [bin, ...rest] = rsyncPushArgs(key, instanceId, local, remote, opts);
  try {
    await execFileAsync(bin, rest, { encoding: "utf-8", timeout: 300_000 });
  } catch (e: any) {
    console.error(`[ec2] rsyncPush: failed (${local} -> ${instanceId}:${remote}):`, e?.message ?? e);
  }
}

/** Pull remote path to local via rsync (async). */
export async function rsyncPull(
  key: string,
  instanceId: string,
  remote: string,
  local: string,
  opts?: Partial<SsmConnectOpts>,
): Promise<void> {
  const [bin, ...rest] = rsyncPullArgs(key, instanceId, remote, local, opts);
  try {
    await execFileAsync(bin, rest, { encoding: "utf-8", timeout: 300_000 });
  } catch (e: any) {
    console.error(`[ec2] rsyncPull: failed (${instanceId}:${remote} -> ${local}):`, e?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// Connectivity & key management
// ---------------------------------------------------------------------------

/**
 * Poll SSH readiness (async).
 * Returns true as soon as a connection succeeds.
 */
export async function waitForSsh(
  key: string,
  instanceId: string,
  opts?: SshExecOpts & { maxAttempts?: number },
): Promise<boolean> {
  const maxAttempts = opts?.maxAttempts ?? 30;
  return poll(
    async () => {
      const { exitCode } = await sshExec(key, instanceId, "echo ok", { ...opts, timeout: opts?.timeout ?? 10_000 });
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
    await execFileAsync("ssh-keygen", ["-t", "ed25519", "-f", privateKeyPath, "-N", "", "-C", `ark-${hostName}`], {
      encoding: "utf-8",
    });
  } catch (err: any) {
    throw new Error(`Failed to generate SSH key: ${err.stderr ?? err.message}`);
  }

  return { publicKeyPath, privateKeyPath };
}
