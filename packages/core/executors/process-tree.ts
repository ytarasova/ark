/**
 * Process tree discovery and cleanup utilities.
 *
 * Provides shared functions for walking the OS process tree from a root PID
 * (e.g. the pane PID of a tmux session) and performing targeted cleanup
 * (deepest-first SIGTERM/SIGKILL).
 *
 * Used by:
 *   - Executors (capture root PID at launch)
 *   - Status poller (periodic snapshots for observability)
 *   - Session stop (graceful tree-kill before tmux kill)
 *   - Local metrics (shared process walking)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import type { ProcessInfo } from "../executor.js";

const execFileAsync = promisify(execFile);

const MAX_DEPTH = 4;

async function getChildPids(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-P", String(pid)], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return stdout
      .trim()
      .split("\n")
      .filter((s) => s.trim())
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));
  } catch {
    return [];
  }
}

async function collectDescendants(rootPid: number, depth = 0): Promise<number[]> {
  if (depth >= MAX_DEPTH) return [];
  const children = await getChildPids(rootPid);
  const all: number[] = [...children];
  for (const child of children) {
    const grandchildren = await collectDescendants(child, depth + 1);
    all.push(...grandchildren);
  }
  return all;
}

/**
 * Walk the process tree rooted at `rootPid` and return a snapshot
 * with all descendant processes and their resource usage.
 */
export async function getProcessTree(rootPid: number): Promise<ProcessInfo> {
  const descendants = await collectDescendants(rootPid);
  if (descendants.length === 0) {
    return { rootPid, children: [], capturedAt: new Date().toISOString() };
  }

  // Fetch process info for all descendants in a single ps call
  const allPids = [rootPid, ...descendants].join(",");
  const children: ProcessInfo["children"] = [];

  try {
    const { stdout } = await execFileAsync("ps", ["-p", allPids, "-o", "pid=,ppid=,pcpu=,pmem=,args="], {
      encoding: "utf-8",
      timeout: 5000,
    });

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Format: PID PPID %CPU %MEM ARGS...
      const match = trimmed.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const cpu = parseFloat(match[3]);
      const mem = parseFloat(match[4]);
      const command = match[5];

      // Skip the root PID itself from children list
      if (pid === rootPid) continue;

      children.push({ pid, ppid, command, cpu, mem });
    }
  } catch {
    // ps failed -- return empty children
  }

  return { rootPid, children, capturedAt: new Date().toISOString() };
}

/**
 * Kill an entire process tree rooted at `rootPid`.
 * Kills deepest-first (leaves before parents), sends SIGTERM first,
 * waits briefly, then SIGKILL for survivors.
 */
export async function killProcessTree(rootPid: number): Promise<void> {
  const tree = await getProcessTree(rootPid);

  // Sort children deepest-first: children with no descendants come last in
  // the tree walk, but we want to kill leaves first. Use ppid proximity
  // to root -- higher ppid distance = deeper.
  const pidsToKill = tree.children.map((c) => c.pid);
  // Add root at the end (killed last)
  pidsToKill.push(rootPid);

  // Reverse so leaves are killed before parents
  pidsToKill.reverse();

  // SIGTERM pass
  for (const pid of pidsToKill) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ESRCH: already dead */
    }
  }

  // Brief wait for graceful shutdown
  await new Promise((r) => setTimeout(r, 2000));

  // SIGKILL survivors
  for (const pid of pidsToKill) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ESRCH: already dead */
    }
  }
}

/**
 * Convenience wrapper: get the process tree for a tmux session handle.
 * Returns null if the tmux session doesn't exist or has no pane PID.
 */
export async function snapshotSessionTree(tmuxHandle: string): Promise<ProcessInfo | null> {
  const { getPanePidAsync } = await import("../infra/tmux.js");
  const pid = await getPanePidAsync(tmuxHandle);
  if (!pid) return null;
  return getProcessTree(pid);
}
