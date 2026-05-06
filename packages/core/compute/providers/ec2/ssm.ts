/**
 * Pure AWS SSM transport primitives for EC2 hosts.
 *
 * Replaces the previous SSH-over-SSM transport (deleted ssh.ts) with direct
 * AWS SDK calls. Every operation that used to shell out to `ssh -o
 * ProxyCommand=...` now goes through `@aws-sdk/client-ssm`:
 *
 *   - Connectivity check  -> DescribeInstanceInformation
 *   - Execute remote cmd  -> SendCommand + GetCommandInvocation poll
 *   - Port forwarding     -> child process spawn of `aws ssm start-session
 *                            --document AWS-StartPortForwardingSession`
 *
 * Why a child process for port-forward?
 *
 *   AWS SSM port forwarding (`AWS-StartPortForwardingSession`) is a
 *   bidirectional WebSocket protocol that AWS only implements inside
 *   `session-manager-plugin`. The SDK's `StartSession` returns a
 *   `StreamUrl`, but no SDK ships a stream client that can talk it; the
 *   only sanctioned way is to invoke the AWS CLI which delegates to the
 *   plugin. The plugin was already a hard requirement under the SSH-over-
 *   SSM transport (it was the `ProxyCommand` worker), so this is not a
 *   new dep -- merely a different way of invoking it.
 *
 * Prerequisites:
 *   - `aws` CLI v2 on PATH
 *   - `session-manager-plugin` on PATH
 *   - The target instance has the SSM agent running and an IAM role that
 *     includes `AmazonSSMManagedInstanceCore`. Without this,
 *     DescribeInstanceInformation never lists it and SendCommand returns
 *     `InvalidInstanceId`.
 *
 * All exec helpers shell-escape every argv element before sending it to
 * `AWS-RunShellScript` -- the remote runs `bash -c "<cmd>"`, so unescaped
 * user input is the same injection risk as it was with `ssh "<cmd>"`.
 */

import { spawn } from "child_process";
import * as fs from "fs";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { shellEscape } from "./shell-escape.js";
import { logDebug, logWarn } from "../../../observability/structured-log.js";
import { awsCredentialsForProfile, withAwsRetry } from "./aws-creds.js";

// AWS SDK error names that indicate the local credentials/profile is unusable
// (expired, missing, malformed, or not authorized). These must NOT be conflated
// with "instance is reachable" -- the agent could be perfectly healthy and we
// just lack the creds to ask. The connectivity-check provision step renders
// whatever error we throw, so a clear "creds expired" surface here is what the
// operator sees in the dashboard instead of a misleading "agent not online".
const AUTH_ERROR_NAMES = new Set([
  "ExpiredToken",
  "ExpiredTokenException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "AccessDenied",
  "AccessDeniedException",
  "AuthFailure",
  "CredentialsProviderError",
  "SSOTokenProviderFailure",
  "SignatureDoesNotMatch",
]);

function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { name?: string; Code?: string; $metadata?: unknown };
  if (e.name && AUTH_ERROR_NAMES.has(e.name)) return true;
  if (e.Code && AUTH_ERROR_NAMES.has(e.Code)) return true;
  // Some SSO-cache failures surface only via the message text.
  return /expired|sso.*token|token.*expired|credentials.*expired/i.test(e.message ?? "");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-call AWS context. `region` is required (SSM is region-scoped).
 * `awsProfile` is optional -- when omitted the AWS SDK uses its default
 * credential chain (env vars, default profile, instance role, etc.).
 */
export interface SsmConnectOpts {
  region: string;
  awsProfile?: string;
}

/** Default region used when a caller doesn't have one to thread through. */
const DEFAULT_REGION = "us-east-1";

/** Terminal `Status` values for `GetCommandInvocation`. */
const TERMINAL_STATUSES = new Set(["Success", "Failed", "Cancelled", "TimedOut"]);

interface SsmExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// Lazy SDK loader
// ---------------------------------------------------------------------------

interface SdkRefs {
  SSMClient: typeof import("@aws-sdk/client-ssm").SSMClient;
  DescribeInstanceInformationCommand: typeof import("@aws-sdk/client-ssm").DescribeInstanceInformationCommand;
  SendCommandCommand: typeof import("@aws-sdk/client-ssm").SendCommandCommand;
  GetCommandInvocationCommand: typeof import("@aws-sdk/client-ssm").GetCommandInvocationCommand;
}

let _sdk: SdkRefs | null = null;

async function loadSdk(): Promise<SdkRefs> {
  if (_sdk) return _sdk;
  const ssm = await import("@aws-sdk/client-ssm");
  _sdk = {
    SSMClient: ssm.SSMClient,
    DescribeInstanceInformationCommand: ssm.DescribeInstanceInformationCommand,
    SendCommandCommand: ssm.SendCommandCommand,
    GetCommandInvocationCommand: ssm.GetCommandInvocationCommand,
  };
  return _sdk;
}

/**
 * Build an SSMClient. Credential refresh + retry on expiry are both
 * handled by the shared aws-creds.ts helpers; this function just wires
 * the self-refreshing provider into a fresh SSMClient.
 *
 * Callers shouldn't invoke this directly -- use `withSsmRetry` so the
 * post-expiry rebuild path runs.
 */
async function buildClient(opts: { region: string; awsProfile?: string }): Promise<SSMClient> {
  const sdk = await loadSdk();
  return new sdk.SSMClient({
    region: opts.region,
    credentials: awsCredentialsForProfile({ profile: opts.awsProfile }),
  });
}

/**
 * Run an SSM SDK call with transparent credential-refresh retry on
 * expiry. Thin wrapper around the shared `withAwsRetry` -- exists so
 * call sites in this file don't have to know about `buildClient`.
 */
async function withSsmRetry<T>(
  opts: { region: string; awsProfile?: string; client?: SSMClient },
  op: (client: SSMClient) => Promise<T>,
): Promise<T> {
  return await withAwsRetry(() => buildClient({ region: opts.region, awsProfile: opts.awsProfile }), op, {
    pinnedClient: opts.client,
    label: "SSM",
  });
}

// ---------------------------------------------------------------------------
// Connectivity check
// ---------------------------------------------------------------------------

/**
 * Returns true when the SSM agent on `instanceId` has reported in (i.e. the
 * instance shows up in DescribeInstanceInformation with status "Online").
 *
 * This is the SSM-equivalent of the old `ssh -o ConnectTimeout=10 echo ok`
 * probe. It's the canonical signal that we can SendCommand or open a
 * port-forwarding session.
 */
export async function ssmCheckInstance(opts: {
  instanceId: string;
  region?: string;
  awsProfile?: string;
  client?: SSMClient;
}): Promise<boolean> {
  const region = opts.region ?? DEFAULT_REGION;
  try {
    const sdk = await loadSdk();
    const out = await withSsmRetry({ region, awsProfile: opts.awsProfile, client: opts.client }, (client) =>
      client.send(
        new sdk.DescribeInstanceInformationCommand({
          Filters: [{ Key: "InstanceIds", Values: [opts.instanceId] }],
        }),
      ),
    );
    const list = out.InstanceInformationList ?? [];
    if (list.length === 0) return false;
    const info = list[0];
    return info.PingStatus === "Online";
  } catch (err) {
    if (isAuthError(err)) {
      const profile = opts.awsProfile ?? "default";
      const original = err instanceof Error ? err.message : String(err);
      throw new Error(
        `AWS credentials for profile '${profile}' are expired or invalid (${original}). ` +
          `Refresh them (e.g. \`aws sso login --profile ${profile}\`) and retry.`,
      );
    }
    logWarn("compute", `ssmCheckInstance: ${opts.instanceId} probe failed (treating as offline)`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ---------------------------------------------------------------------------
// SendCommand-based exec
// ---------------------------------------------------------------------------

/**
 * Execute `cmd` on the remote via `AWS-RunShellScript`.
 *
 * Polls `GetCommandInvocation` with exponential backoff (200ms -> 2s cap)
 * until the status is terminal. Never throws -- a failed AWS call surfaces
 * as `{ stdout: "", stderr: <message>, exitCode: 1 }` so call sites can
 * use the same shape they used with the old ssh.ts.
 */
export async function ssmExec(opts: {
  instanceId: string;
  region?: string;
  awsProfile?: string;
  command: string;
  timeoutMs?: number;
  client?: SSMClient;
}): Promise<SsmExecResult> {
  const region = opts.region ?? DEFAULT_REGION;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  // SSM execution timeout is in seconds and must be a positive integer.
  const execSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));

  let sdk: SdkRefs;
  try {
    sdk = await loadSdk();
  } catch (err) {
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }

  const ctx = { region, awsProfile: opts.awsProfile, client: opts.client };

  let commandId: string | undefined;
  try {
    const send = await withSsmRetry(ctx, (client) =>
      client.send(
        new sdk.SendCommandCommand({
          DocumentName: "AWS-RunShellScript",
          InstanceIds: [opts.instanceId],
          Parameters: {
            commands: [opts.command],
            executionTimeout: [String(execSeconds)],
          },
        }),
      ),
    );
    commandId = send.Command?.CommandId;
  } catch (err) {
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
  }
  if (!commandId) {
    return { stdout: "", stderr: "ssmExec: SendCommand returned no CommandId", exitCode: 1 };
  }

  // Poll GetCommandInvocation. The first read can race the SendCommand
  // propagation and return InvocationDoesNotExist for a brief window;
  // we treat that as "not ready yet" and continue polling.
  const startedAt = Date.now();
  let delay = 200;
  while (Date.now() - startedAt <= timeoutMs + 5_000) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(2_000, Math.floor(delay * 1.6));
    let inv: import("@aws-sdk/client-ssm").GetCommandInvocationCommandOutput;
    try {
      inv = await withSsmRetry(ctx, (client) =>
        client.send(
          new sdk.GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: opts.instanceId,
          }),
        ),
      );
    } catch (err: any) {
      const code = err?.name ?? err?.Code ?? "";
      if (code === "InvocationDoesNotExist") continue;
      return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
    }
    const status = inv.Status ?? "";
    if (!TERMINAL_STATUSES.has(status)) continue;
    return {
      stdout: inv.StandardOutputContent ?? "",
      stderr: inv.StandardErrorContent ?? "",
      exitCode: typeof inv.ResponseCode === "number" ? inv.ResponseCode : status === "Success" ? 0 : 1,
    };
  }
  return { stdout: "", stderr: `ssmExec: timed out waiting for command ${commandId}`, exitCode: 1 };
}

/**
 * Execute a remote command from an argv array, shell-escaping each element
 * before joining them. Mirrors the shape of the old `sshExecArgs`.
 *
 * Prefer this over `ssmExec({ command: \`... \${var} ...\` })` whenever any
 * element is derived from user input (session id, tenant id, workdir, etc.).
 * SSM `AWS-RunShellScript` runs `bash -c "<cmd>"`, so unescaped values are
 * the same injection risk as raw ssh.
 */
export async function ssmExecArgs(opts: {
  instanceId: string;
  region?: string;
  awsProfile?: string;
  argv: string[];
  timeoutMs?: number;
  client?: SSMClient;
}): Promise<SsmExecResult> {
  if (!Array.isArray(opts.argv) || opts.argv.length === 0) {
    throw new Error("ssmExecArgs: argv must be a non-empty array");
  }
  const escaped = opts.argv.map((a) => {
    if (typeof a !== "string") {
      throw new Error(`ssmExecArgs: argv elements must be strings, got ${typeof a}`);
    }
    return shellEscape(a);
  });
  return ssmExec({ ...opts, command: escaped.join(" ") });
}

// ---------------------------------------------------------------------------
// Port forwarding via session-manager-plugin
// ---------------------------------------------------------------------------

/**
 * Spawn a long-lived `aws ssm start-session
 * --document-name AWS-StartPortForwardingSession` child process.
 *
 * The returned PID is the AWS CLI process; killing it tears the underlying
 * SSM session and the local listening socket down. The CLI re-execs into
 * `session-manager-plugin` after handshaking with SSM, but the PID we hand
 * back is stable for the lifetime of the forward (the plugin runs as a
 * grand-child but exits when its parent dies).
 *
 * NB: the parent process (this Node process) MUST NOT exit before the
 * caller has had a chance to record the PID -- we spawn detached + unref
 * so the child outlives the event loop, but the caller is still responsible
 * for calling `ssmKillPortForward` when it's done.
 */
export async function ssmStartPortForward(opts: {
  instanceId: string;
  region?: string;
  awsProfile?: string;
  localPort: number;
  remotePort: number;
  /**
   * Maximum time to wait for the local port to start accepting TCP
   * connections after the AWS CLI is spawned. SSM start-session does an
   * authenticated handshake before re-execing into `session-manager-plugin`,
   * which then opens the local listener -- on cold paths this takes 5-12s.
   * We poll until the connect succeeds or this deadline expires; without
   * this wait the caller (e.g., `arkd-probe`) gets ECONNREFUSED on every
   * attempt because the listener isn't bound yet, even though `aws ssm`
   * is technically running.
   */
  readyTimeoutMs?: number;
}): Promise<{ pid: number }> {
  const region = opts.region ?? DEFAULT_REGION;
  const args = [
    "ssm",
    "start-session",
    "--target",
    opts.instanceId,
    "--document-name",
    "AWS-StartPortForwardingSession",
    "--parameters",
    `portNumber=${opts.remotePort},localPortNumber=${opts.localPort}`,
    "--region",
    region,
  ];
  if (opts.awsProfile) args.push("--profile", opts.awsProfile);

  // `stdio: "ignore"` closes stdin/stdout/stderr -- but
  // `session-manager-plugin` (re-exec'd by `aws ssm start-session`) needs
  // open fds for its WebSocket framing layer; closing them silently breaks
  // the tunnel and the local listener never binds. Pipe stdout/stderr to
  // /dev/null instead so the plugin gets real fds to write to.
  const devnull = fs.openSync("/dev/null", "w");
  const child = spawn("aws", args, {
    detached: true,
    stdio: ["ignore", devnull, devnull],
  });
  // Close our copy of the /dev/null fd; the child kept its own dup.
  fs.closeSync(devnull);
  child.unref();
  const pid = child.pid ?? -1;

  // Poll the local port until something accepts a TCP connection, or
  // bail with a clear error when the deadline expires. The plugin
  // doesn't print anything to stdout/stderr we can grep on (we
  // explicitly `stdio: "ignore"`), so a TCP probe is the most reliable
  // readiness signal.
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000);
  const net = await import("net");
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: "127.0.0.1", port: opts.localPort });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        resolve(false);
      });
      sock.setTimeout(500, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return { pid };
    await new Promise((r) => setTimeout(r, 250));
  }

  // Tear down the orphaned child before throwing so we don't leak it.
  if (pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone -- expected when the CLI exited on auth failure
    }
  }
  throw new Error(
    `ssmStartPortForward: local port ${opts.localPort} did not start listening within ${
      opts.readyTimeoutMs ?? 30_000
    }ms (instanceId=${opts.instanceId} -> :${opts.remotePort})`,
  );
}

/**
 * Best-effort SIGTERM the port-forward child. Falls through to SIGKILL
 * after a 1s grace window if the process is still alive. No-op on
 * non-positive PIDs (caller never recorded one).
 */
export function ssmKillPortForward(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    logDebug("compute", "ssmKillPortForward: SIGTERM target already gone");
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, 0); // probe
    } catch {
      return; // gone -- nothing more to do
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      logDebug("compute", "ssmKillPortForward: SIGKILL race -- target already exited");
    }
  }, 1_000).unref?.();
}

// ---------------------------------------------------------------------------
// Readiness wait
// ---------------------------------------------------------------------------

/**
 * Poll `ssmCheckInstance` until the SSM agent reports Online, or the
 * attempt budget is exhausted. Returns true on success.
 */
export async function ssmWaitForReady(opts: {
  instanceId: string;
  region?: string;
  awsProfile?: string;
  maxAttempts?: number;
  delayMs?: number;
  client?: SSMClient;
}): Promise<boolean> {
  const maxAttempts = opts.maxAttempts ?? 30;
  const delayMs = opts.delayMs ?? 5_000;
  for (let i = 0; i < maxAttempts; i++) {
    if (await ssmCheckInstance(opts)) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
