/**
 * Firecracker path layout tests. Cheap to run, catches regressions where
 * refactors accidentally move the on-disk cache layout without updating
 * every downstream consumer.
 *
 * Note: os.homedir() does NOT read $HOME on POSIX -- it uses getpwuid() --
 * so we can't sandbox by overriding HOME. Instead these tests assert paths
 * relative to firecrackerRoot() itself, which is the public contract.
 */

import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, rmSync } from "fs";
import { join } from "path";

import {
  firecrackerRoot,
  kernelPath,
  rootfsPath,
  vmLogPath,
  vmSnapshotPaths,
  vmSocketPath,
  vmWorkDir,
} from "../core/firecracker/paths.js";

// Cleanup: remove any directories we created under the real ~/.ark/firecracker
// during the test. Use unique test-only shas and vm ids so we only touch our
// own artifacts.
const TEST_KERNEL_SHA = "test-sha-kernel-paths-spec";
const TEST_ROOTFS_SHA = "test-sha-rootfs-paths-spec";
const TEST_VM_ID = "test-vm-paths-spec";

afterAll(() => {
  const root = firecrackerRoot();
  rmSync(join(root, "kernel", TEST_KERNEL_SHA), { recursive: true, force: true });
  rmSync(join(root, "rootfs", TEST_ROOTFS_SHA), { recursive: true, force: true });
  rmSync(join(root, "vms", TEST_VM_ID), { recursive: true, force: true });
});

describe("firecracker paths", () => {
  it("firecrackerRoot ends in .ark/firecracker", () => {
    expect(firecrackerRoot().endsWith(join(".ark", "firecracker"))).toBe(true);
  });

  it("kernelPath returns <root>/kernel/<sha>/vmlinux and creates the parent dir", () => {
    const p = kernelPath(TEST_KERNEL_SHA);
    expect(p).toBe(join(firecrackerRoot(), "kernel", TEST_KERNEL_SHA, "vmlinux"));
    expect(existsSync(join(firecrackerRoot(), "kernel", TEST_KERNEL_SHA))).toBe(true);
  });

  it("rootfsPath returns <root>/rootfs/<sha>/rootfs.ext4 and creates the parent dir", () => {
    const p = rootfsPath(TEST_ROOTFS_SHA);
    expect(p).toBe(join(firecrackerRoot(), "rootfs", TEST_ROOTFS_SHA, "rootfs.ext4"));
    expect(existsSync(join(firecrackerRoot(), "rootfs", TEST_ROOTFS_SHA))).toBe(true);
  });

  it("vmWorkDir returns <root>/vms/<id>/ and creates the snapshot subdir", () => {
    const dir = vmWorkDir(TEST_VM_ID);
    expect(dir).toBe(join(firecrackerRoot(), "vms", TEST_VM_ID));
    expect(existsSync(join(dir, "snapshot"))).toBe(true);
  });

  it("vmSocketPath is inside the vm work dir", () => {
    expect(vmSocketPath(TEST_VM_ID)).toBe(join(firecrackerRoot(), "vms", TEST_VM_ID, "firecracker.sock"));
  });

  it("vmLogPath is inside the vm work dir", () => {
    expect(vmLogPath(TEST_VM_ID)).toBe(join(firecrackerRoot(), "vms", TEST_VM_ID, "firecracker.log"));
  });

  it("vmSnapshotPaths returns mem + state inside snapshot/", () => {
    const snap = vmSnapshotPaths(TEST_VM_ID);
    expect(snap.memFilePath).toBe(join(firecrackerRoot(), "vms", TEST_VM_ID, "snapshot", "mem"));
    expect(snap.stateFilePath).toBe(join(firecrackerRoot(), "vms", TEST_VM_ID, "snapshot", "state"));
  });
});
