/**
 * Daemon lockfile management.
 *
 * The daemon writes ~/.ark/daemon.json on start and removes it on shutdown.
 * Clients (TUI, CLI) read this lockfile to auto-discover a running daemon.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { DAEMON_LOCKFILE_NAME } from "../core/constants.js";

export interface DaemonInfo {
  pid: number;
  ws_url: string;
  conductor_port: number;
  arkd_port: number;
  web_port?: number;
  started_at: string;
}

/** Lockfile path for a given arkDir. */
export function lockfilePath(arkDir: string): string {
  return join(arkDir, DAEMON_LOCKFILE_NAME);
}

/** Write the lockfile atomically (write to tmp, rename). */
export function writeLockfile(arkDir: string, info: DaemonInfo): void {
  const path = lockfilePath(arkDir);
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(info, null, 2) + "\n");
  // Rename is atomic on POSIX filesystems
  const { renameSync } = require("fs");
  renameSync(tmpPath, path);
}

/** Read and parse the lockfile. Returns null if missing or corrupted. */
export function readLockfile(arkDir: string): DaemonInfo | null {
  const path = lockfilePath(arkDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const info = JSON.parse(raw) as DaemonInfo;
    if (!info.pid || !info.ws_url) return null;
    return info;
  } catch {
    return null;
  }
}

/** Remove the lockfile (best-effort, for shutdown cleanup). */
export function removeLockfile(arkDir: string): void {
  try {
    unlinkSync(lockfilePath(arkDir));
  } catch { /* already gone */ }
}

/** Check if the process recorded in the lockfile is still alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a daemon is running by reading the lockfile and verifying the pid.
 * Returns { running: true, info } if the daemon process is alive,
 * { running: false } if not (also cleans up stale lockfiles).
 */
export function isDaemonRunning(arkDir: string): { running: boolean; info?: DaemonInfo } {
  const info = readLockfile(arkDir);
  if (!info) return { running: false };

  if (!isPidAlive(info.pid)) {
    // Stale lockfile -- daemon crashed without cleanup
    removeLockfile(arkDir);
    return { running: false };
  }

  return { running: true, info };
}
