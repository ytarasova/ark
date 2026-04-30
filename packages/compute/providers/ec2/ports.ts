/**
 * SSH tunnel management for forwarding ports from remote EC2 hosts.
 *
 * Transport: SSH runs over SSM Session Manager. The host arg is an
 * EC2 instance_id; tunnels still use SSH `-L` / `-R` flags but are
 * carried by SSM rather than direct TCP.
 */

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import type { PortDecl, PortStatus } from "../../types.js";
import { SSH_OPTS, sshExec, buildSsmProxyArgs, type SsmConnectOpts } from "./ssh.js";
import { REMOTE_USER } from "./constants.js";
import { logInfo, logDebug } from "../../../core/observability/structured-log.js";

const execFileAsync = promisify(execFile);

/**
 * Build SSH args for a background tunnel process.
 * Produces: ssh -i key -N -f -L port:localhost:port ... ${REMOTE_USER}@instance_id
 */
export function buildTunnelArgs(key: string, instanceId: string, ports: PortDecl[], ssm: SsmConnectOpts): string[] {
  const args = ["ssh", "-i", key, ...SSH_OPTS, ...buildSsmProxyArgs(ssm), "-N", "-f"];
  for (const p of ports) {
    args.push("-L", `${p.port}:localhost:${p.port}`);
  }
  args.push(`${REMOTE_USER}@${instanceId}`);
  return args;
}

/**
 * Spawn a background SSH process with -L for each port.
 * Non-blocking - returns immediately.
 */
export function setupTunnels(key: string, instanceId: string, ports: PortDecl[], ssm: SsmConnectOpts): void {
  if (ports.length === 0) return;

  const args = buildTunnelArgs(key, instanceId, ports, ssm);
  const [bin, ...rest] = args;

  const child = spawn(bin, rest, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Kill SSH processes that are forwarding the given ports.
 * Uses lsof to find PIDs listening on each port, then kills them.
 */
export async function teardownTunnels(ports: PortDecl[]): Promise<void> {
  for (const p of ports) {
    try {
      const { stdout } = await execFileAsync("lsof", ["-ti", `:${p.port}`], {
        encoding: "utf-8",
      });
      const output = stdout.trim();

      if (output) {
        const pids = output.split("\n").filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), "SIGTERM");
          } catch {
            logDebug("compute", "process may already be gone");
          }
        }
      }
    } catch {
      logInfo("compute", "lsof returns non-zero when no matching processes found");
    }
  }
}

/**
 * Returns the PID of an existing reverse tunnel for `(target, port)`, or null.
 * Uses `pgrep -f` (cross-platform: macOS + Linux) with a substring pattern
 * unique enough to avoid false positives -- `-R <port>:localhost:<port>` and
 * `${REMOTE_USER}@<target>` together only ever appear in the SSH args spawned
 * by setupReverseTunnel below. macOS pgrep does NOT support the Linux `-a`
 * flag, so we just list PIDs and trust the pattern.
 */
async function findReverseTunnelPid(target: string, port: number): Promise<number | null> {
  try {
    // Pattern is a substring match. Lead with the port-pair (not the `-R `
    // prefix) so pgrep doesn't try to parse it as its own flag, and pass
    // `--` to terminate flag parsing for safety in case future patterns
    // happen to start with `-`.
    const pattern = `${port}:localhost:${port} ${REMOTE_USER}@${target}`;
    const { stdout } = await execFileAsync("pgrep", ["-f", "--", pattern], { encoding: "utf-8" });
    const pid = stdout
      .trim()
      .split("\n")
      .map((line) => parseInt(line.trim(), 10))
      .find((n) => Number.isFinite(n));
    return pid ?? null;
  } catch {
    // pgrep exits non-zero when nothing matches.
    return null;
  }
}

/**
 * Spawn a background SSH reverse tunnel (-R) so the remote host can reach a
 * service on the local machine (e.g. the conductor at localhost:19100).
 * Remote `localhost:port` -> local `localhost:port`.
 *
 * Idempotent: if a matching tunnel for `(instanceId, port)` is already running
 * we return its PID without spawning a duplicate. The duplicate would fail
 * fast on the remote port-bind anyway, but logging gets noisy.
 */
export async function setupReverseTunnel(
  key: string,
  instanceId: string,
  port: number,
  ssm: SsmConnectOpts,
): Promise<{ pid: number | null; reused: boolean }> {
  const existing = await findReverseTunnelPid(instanceId, port);
  if (existing) return { pid: existing, reused: true };

  const args = [
    "ssh",
    "-i",
    key,
    ...SSH_OPTS,
    ...buildSsmProxyArgs(ssm),
    "-N",
    "-f",
    "-R",
    `${port}:localhost:${port}`,
    `${REMOTE_USER}@${instanceId}`,
  ];
  const [bin, ...rest] = args;
  const child = spawn(bin, rest, { detached: true, stdio: "ignore" });
  child.unref();

  // ssh -f forks immediately and the parent exits, so the spawned child PID
  // is the SHORT-LIVED parent. Resolve the actual long-lived tunnel PID via
  // pgrep -- with a few retries because pgrep can race the fork.
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 100));
    const pid = await findReverseTunnelPid(instanceId, port);
    if (pid) return { pid, reused: false };
  }
  return { pid: null, reused: false };
}

/** Kill the reverse tunnel for `(instanceId, port)`, if any. Best-effort. */
export async function teardownReverseTunnel(instanceId: string, port: number): Promise<boolean> {
  const pid = await findReverseTunnelPid(instanceId, port);
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    logDebug("compute", "reverse tunnel pid already gone");
    return false;
  }
}

/**
 * SSH into the remote host, run `ss -tln`, and check which declared ports
 * are actually listening. Returns a PortStatus[] with listening: true/false.
 */
export async function probeRemotePorts(
  key: string,
  instanceId: string,
  ports: PortDecl[],
  ssm: SsmConnectOpts,
): Promise<PortStatus[]> {
  if (ports.length === 0) return [];

  const { stdout: ssOutput } = await sshExec(key, instanceId, "ss -tln", { ...ssm, timeout: 15_000 });

  if (!ssOutput) {
    // If SSH fails, mark all ports as not listening
    return ports.map((p) => ({ ...p, listening: false }));
  }

  return ports.map((p) => ({
    ...p,
    listening: ssOutput.includes(`:${p.port} `) || ssOutput.includes(`:${p.port}\n`),
  }));
}
