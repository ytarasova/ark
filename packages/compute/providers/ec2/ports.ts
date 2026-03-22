/**
 * SSH tunnel management for forwarding ports from remote EC2 hosts.
 */

import { execFileSync, spawn } from "child_process";
import type { PortDecl, PortStatus } from "../../types.js";
import { SSH_OPTS } from "./ssh.js";
import { sshBaseArgs } from "./ssh.js";

/**
 * Build SSH args for a background tunnel process.
 * Produces: ssh -i key -N -f -L port:localhost:port ... ubuntu@ip
 */
export function buildTunnelArgs(key: string, ip: string, ports: PortDecl[]): string[] {
  const args = ["ssh", "-i", key, ...SSH_OPTS, "-N", "-f"];
  for (const p of ports) {
    args.push("-L", `${p.port}:localhost:${p.port}`);
  }
  args.push(`ubuntu@${ip}`);
  return args;
}

/**
 * Spawn a background SSH process with -L for each port.
 * Non-blocking — returns immediately.
 */
export function setupTunnels(key: string, ip: string, ports: PortDecl[]): void {
  if (ports.length === 0) return;

  const args = buildTunnelArgs(key, ip, ports);
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
export function teardownTunnels(ports: PortDecl[]): void {
  for (const p of ports) {
    try {
      const output = execFileSync("lsof", ["-ti", `:${p.port}`], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();

      if (output) {
        const pids = output.split("\n").filter(Boolean);
        for (const pid of pids) {
          try {
            process.kill(Number(pid), "SIGTERM");
          } catch {
            // process may already be gone
          }
        }
      }
    } catch {
      // lsof returns non-zero when no matching processes found
    }
  }
}

/**
 * SSH into the remote host, run `ss -tln`, and check which declared ports
 * are actually listening. Returns a PortStatus[] with listening: true/false.
 */
export function probeRemotePorts(key: string, ip: string, ports: PortDecl[]): PortStatus[] {
  if (ports.length === 0) return [];

  let ssOutput = "";
  const args = sshBaseArgs(key, ip);
  const [bin, ...rest] = args;
  rest.push("ss -tln");

  try {
    ssOutput = execFileSync(bin, rest, {
      encoding: "utf-8",
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // If SSH fails, mark all ports as not listening
    return ports.map((p) => ({ ...p, listening: false }));
  }

  return ports.map((p) => ({
    ...p,
    listening: ssOutput.includes(`:${p.port} `) || ssOutput.includes(`:${p.port}\n`),
  }));
}
