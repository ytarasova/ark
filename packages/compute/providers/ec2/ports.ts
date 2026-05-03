/**
 * Port-forward + remote-port-probe helpers for EC2 hosts.
 *
 * Port forwarding goes through `aws ssm start-session
 * --document-name AWS-StartPortForwardingSession` (the only SSM-sanctioned
 * way to pipe TCP through Session Manager). The probe uses `ss -tln` over
 * SSM SendCommand.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { PortDecl, PortStatus } from "../../types.js";
import { ssmExec, ssmStartPortForward, type SsmConnectOpts } from "./ssm.js";
import { logInfo, logDebug } from "../../../core/observability/structured-log.js";

const execFileAsync = promisify(execFile);

/**
 * Spawn a background SSM port-forward for each declared port. Each
 * forward waits until the local listener is bound (or a fresh-tunnel
 * deadline expires) before returning. Tunnels are launched in parallel
 * so total wall time tracks the slowest single tunnel, not the sum.
 */
export async function setupTunnels(instanceId: string, ports: PortDecl[], ssm: SsmConnectOpts): Promise<void> {
  if (ports.length === 0) return;
  await Promise.all(
    ports.map((p) =>
      ssmStartPortForward({
        instanceId,
        region: ssm.region,
        awsProfile: ssm.awsProfile,
        localPort: p.port,
        remotePort: p.port,
      }),
    ),
  );
}

/**
 * Kill processes listening on the given local ports. Used to tear down
 * port-forwards during compute stop/destroy.
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
 * Returns the PID of an existing forward for `(instanceId, remotePort)`, or null.
 *
 * The pgrep pattern matches against the AWS CLI command-line shape produced
 * by `ssmStartPortForward` -- specifically it looks for the
 * `--target <instanceId>` and the `portNumber=<remotePort>` substrings. The
 * local port is dynamically allocated and intentionally not part of the
 * match key.
 */
async function findForwardTunnelPid(instanceId: string, remotePort: number): Promise<number | null> {
  try {
    const pattern = `start-session.*${instanceId}.*portNumber=${remotePort}`;
    const { stdout } = await execFileAsync("pgrep", ["-f", "--", pattern], { encoding: "utf-8" });
    const pid = stdout
      .trim()
      .split("\n")
      .map((line) => parseInt(line.trim(), 10))
      .find((n) => Number.isFinite(n));
    return pid ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the local-side port a forward is bound to by parsing the matched AWS
 * CLI command line. Was used by the now-removed setupForwardTunnel reuse
 * branch; kept for any future caller that needs to inspect a specific
 * forward's local port (e.g. for diagnostics or a re-attach UI).
 */
// @ts-expect-error keep for diagnostics; prefix-rename if reused
async function _readForwardTunnelLocalPort(pid: number, remotePort: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8" });
    const match = stdout.match(new RegExp(`portNumber=${remotePort}[^\\s]*localPortNumber=(\\d+)`));
    if (!match) {
      const alt = stdout.match(new RegExp(`localPortNumber=(\\d+)[^\\s]*portNumber=${remotePort}`));
      if (!alt) return null;
      const port = parseInt(alt[1], 10);
      return Number.isFinite(port) ? port : null;
    }
    const port = parseInt(match[1], 10);
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

/**
 * Spawn a background SSM port-forward so the conductor can reach a service
 * on the remote host.
 *
 * Per-session isolation (#423): we deliberately DO NOT reuse an existing
 * tunnel that matches `(instanceId, remotePort)`. Each caller gets its own
 * tunnel on its own local port. Reuse caused subtle bugs where session A
 * and session B shared a tunnel; when A's setup wrote the port to compute
 * config and B's setup later overwrote it, the first session was reading a
 * port that pointed at a different (or dead) tunnel. With per-session
 * tunnels, every session's port is private, persisted to its own
 * `session.config.arkd_local_forward_port`, and stays valid for the
 * session's lifetime.
 *
 * Cost: N concurrent sessions => N tunnels. Each tunnel is a single
 * `aws ssm start-session` process (~15 MB) — bounded by your concurrency.
 * Worth it for the isolation guarantee.
 */
export async function setupForwardTunnel(
  instanceId: string,
  remotePort: number,
  localPort: number,
  ssm: SsmConnectOpts,
): Promise<{ pid: number | null; localPort: number; reused: boolean }> {
  const { pid } = await ssmStartPortForward({
    instanceId,
    region: ssm.region,
    awsProfile: ssm.awsProfile,
    localPort,
    remotePort,
  });
  return { pid: pid > 0 ? pid : null, localPort, reused: false };
}

/** Kill the forward for `(instanceId, remotePort)`, if any. Best-effort. */
export async function teardownForwardTunnel(instanceId: string, remotePort: number): Promise<boolean> {
  const pid = await findForwardTunnelPid(instanceId, remotePort);
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    logDebug("compute", "forward tunnel pid already gone");
    return false;
  }
}

/**
 * Run `ss -tln` over SSM and check which declared ports are actually
 * listening. Returns a PortStatus[] with listening: true/false.
 */
export async function probeRemotePorts(
  instanceId: string,
  ports: PortDecl[],
  ssm: SsmConnectOpts,
): Promise<PortStatus[]> {
  if (ports.length === 0) return [];

  const { stdout: ssOutput } = await ssmExec({
    instanceId,
    region: ssm.region,
    awsProfile: ssm.awsProfile,
    command: "ss -tln",
    timeoutMs: 15_000,
  });

  if (!ssOutput) {
    return ports.map((p) => ({ ...p, listening: false }));
  }

  return ports.map((p) => ({
    ...p,
    listening: ssOutput.includes(`:${p.port} `) || ssOutput.includes(`:${p.port}\n`),
  }));
}
