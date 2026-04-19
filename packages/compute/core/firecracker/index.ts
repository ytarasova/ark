/**
 * Firecracker microVM manager -- low-level module.
 *
 * This module does NOT implement the `Compute` interface -- the
 * `FirecrackerCompute` class wraps it. Keep this module free of ark-specific
 * coupling (AppContext, session model, etc.) so it can also be reused from
 * the pool layer and remote microVM backends.
 */

export { createVm } from "./vm.js";
export type { FirecrackerVm, FirecrackerVmSpec, SnapshotOpts, SnapshotArtifacts, ApiResponse } from "./vm.js";
export { ensureBridge, createTap, removeTap, assignGuestIp } from "./network.js";
export type { GuestAddr } from "./network.js";
export {
  kernelPath,
  rootfsPath,
  vmWorkDir,
  vmSocketPath,
  vmLogPath,
  vmSnapshotPaths,
  firecrackerRoot,
} from "./paths.js";
export { isFirecrackerAvailable } from "./availability.js";
export type { AvailabilityResult } from "./availability.js";
export { ensureRootfs, __setRootfsHooksForTesting, __resetRootfsHooksForTesting } from "./rootfs.js";
export type { RootfsPaths, RootfsHooks } from "./rootfs.js";
export { FirecrackerCompute, registerFirecrackerIfAvailable } from "./compute.js";
export type { FirecrackerComputeDeps, FirecrackerMeta } from "./compute.js";
