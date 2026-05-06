/**
 * Firecracker cache + per-VM work directory layout.
 *
 * Layout under `~/.ark/firecracker/`:
 *
 *   kernel/<sha>/vmlinux            -- uncompressed ELF kernel (Firecracker
 *                                      only supports ELF, not bzImage)
 *   rootfs/<sha>/rootfs.ext4        -- base rootfs image. Treated as read-only
 *                                      by default in the VM spec; callers that
 *                                      opt out must clone it themselves.
 *   vms/<vm-id>/                    -- ephemeral per-VM working dir. Holds the
 *     firecracker.sock              -- API socket (Firecracker UDS path must
 *                                      be <= 108 bytes on Linux; the paths
 *                                      below stay well under that cap when
 *                                      rooted in `$HOME/.ark`)
 *     firecracker.log               -- firecracker stderr+stdout tee
 *     snapshot/mem                  -- snapshot memory file (when taken)
 *     snapshot/state                -- snapshot state file (when taken)
 *
 * We content-address by caller-provided sha to make downloads / rebuilds
 * cacheable without forcing the manager to hash anything itself (hashing a
 * multi-GB rootfs on every boot would be unacceptable; the caller -- the
 * image-management pipeline -- already computes a sha when it fetches the
 * blob).
 */

import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Root of all Firecracker state. Override via `ARK_DIR` (consumed indirectly via HOME). */
export function firecrackerRoot(): string {
  // We deliberately do NOT read `config.dirs.ark` here: this module is a leaf
  // utility with no AppContext coupling so it can be used from
  // `FirecrackerCompute` before app boot is complete. If a future caller needs
  // a non-default root, add an optional arg rather than pulling in config.
  return join(homedir(), ".ark", "firecracker");
}

/** `~/.ark/firecracker/kernel/<sha>/vmlinux` -- ensures parent dir exists. */
export function kernelPath(sha: string): string {
  const dir = join(firecrackerRoot(), "kernel", sha);
  mkdirSync(dir, { recursive: true });
  return join(dir, "vmlinux");
}

/** `~/.ark/firecracker/rootfs/<sha>/rootfs.ext4` -- ensures parent dir exists. */
export function rootfsPath(sha: string): string {
  const dir = join(firecrackerRoot(), "rootfs", sha);
  mkdirSync(dir, { recursive: true });
  return join(dir, "rootfs.ext4");
}

/** `~/.ark/firecracker/vms/<vm-id>/` -- ensures dir + `snapshot/` subdir exist. */
export function vmWorkDir(vmId: string): string {
  const dir = join(firecrackerRoot(), "vms", vmId);
  mkdirSync(join(dir, "snapshot"), { recursive: true });
  return dir;
}

/** API socket path for a VM. Caller must ensure this is <= 108 bytes. */
export function vmSocketPath(vmId: string): string {
  return join(vmWorkDir(vmId), "firecracker.sock");
}

/** Firecracker process log path (stdout + stderr tee'd here). */
export function vmLogPath(vmId: string): string {
  return join(vmWorkDir(vmId), "firecracker.log");
}

/** Default snapshot artifact paths for a VM. Callers can override via SnapshotOpts. */
export function vmSnapshotPaths(vmId: string): { memFilePath: string; stateFilePath: string } {
  const dir = join(vmWorkDir(vmId), "snapshot");
  return {
    memFilePath: join(dir, "mem"),
    stateFilePath: join(dir, "state"),
  };
}
