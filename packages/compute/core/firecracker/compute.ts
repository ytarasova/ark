/**
 * FirecrackerCompute -- integration of the low-level Firecracker VM manager.
 *
 * This compute:
 *   1. Checks Firecracker availability on the host (Linux + /dev/kvm + binary).
 *   2. Ensures kernel + rootfs are cached locally.
 *   3. Sets up host-side networking (Linux bridge + per-VM TAP in a /30).
 *   4. Boots a microVM that runs arkd on :19300 bound to 0.0.0.0.
 *   5. Waits for arkd readiness by polling the guest's /snapshot endpoint
 *      from the host (the TAP bridge is host-reachable).
 *
 * Handle shape:
 *
 *   handle.meta.firecracker = {
 *     vmId, socketPath, guestIp, hostIp, tapName,
 *     kernelPath, rootfsPath, arkdUrl,
 *   }
 *
 * Runtime composition:
 *   - `FirecrackerCompute × DirectRuntime` = agent runs natively in the VM.
 *   - `FirecrackerCompute × DockerRuntime` = VM hosts docker with arkd
 *     sidecar (not yet wired; no different from the compute's perspective).
 *
 * Snapshot / restore delegate to the VM manager's native pause+snapshot and
 * load+resume APIs, writing / reading from per-VM paths under
 * `~/.ark/firecracker/vms/<vmId>/snapshot/`. A higher-level SnapshotStore
 * (object storage, cross-host restore) is wired separately; the compute-
 * level API here is intentionally end-to-end against the local filesystem
 * so existing tests can exercise snapshot() -> restore() today.
 */

import type { AppContext } from "../../../core/app.js";
import { logInfo } from "../../../core/observability/structured-log.js";
import type { Compute, ComputeCapabilities, ComputeHandle, ComputeKind, ProvisionOpts, Snapshot } from "../types.js";
// ^ core/types.ts -- the new Compute/Runtime abstractions. Do NOT import from
// `packages/compute/types.ts`, which is the legacy ComputeProvider surface.
import { NotSupportedError } from "../types.js";
import { isFirecrackerAvailable } from "./availability.js";
import { assignGuestIp, createTap, ensureBridge, removeTap } from "./network.js";
import { vmSnapshotPaths, vmWorkDir } from "./paths.js";
import { ensureRootfs } from "./rootfs.js";
import { createVm, type FirecrackerVm, type FirecrackerVmSpec } from "./vm.js";

/** Default bridge name. One bridge per host is enough for the local pool. */
const BRIDGE_NAME = "fc0";
/** Arkd guest-side port; matches the conductor arkd-sidecar contract. */
const GUEST_ARKD_PORT = 19300;
/** Max time we wait for arkd /snapshot to answer after InstanceStart. */
const ARKD_READY_TIMEOUT_MS = 60_000;
/** How often we poll /snapshot while waiting. */
const ARKD_POLL_INTERVAL_MS = 500;

/**
 * Dependency-injection surface. Tests swap these to avoid touching the real
 * Firecracker binary, ip(8), or network. Production wiring pulls in the real
 * implementations from the sibling modules.
 *
 * We factor the deps through a `Deps` struct rather than individual setters
 * so tests can pass one object with a subset overridden (the default object
 * fills in the rest). Matches the pattern used in `docker.ts`.
 */
export interface FirecrackerComputeDeps {
  isFirecrackerAvailable: typeof isFirecrackerAvailable;
  ensureRootfs: typeof ensureRootfs;
  ensureBridge: typeof ensureBridge;
  createTap: typeof createTap;
  removeTap: typeof removeTap;
  assignGuestIp: typeof assignGuestIp;
  createVm: (spec: FirecrackerVmSpec) => FirecrackerVm;
  /** Polls an HTTP endpoint until it answers 2xx or the deadline expires. */
  waitForArkdReady: (url: string, timeoutMs: number) => Promise<void>;
}

const productionDeps: FirecrackerComputeDeps = {
  isFirecrackerAvailable,
  ensureRootfs,
  ensureBridge,
  createTap,
  removeTap,
  assignGuestIp,
  createVm,
  waitForArkdReady: defaultWaitForArkdReady,
};

/**
 * Meta blob stored on the ComputeHandle after `provision`. All backends are
 * free to put whatever they like on `meta`; we name our slot explicitly so
 * nothing collides with a future runtime that wants its own.
 */
export interface FirecrackerMeta {
  vmId: string;
  socketPath: string;
  guestIp: string;
  hostIp: string;
  tapName: string;
  kernelPath: string;
  rootfsPath: string;
  arkdUrl: string;
}

export class FirecrackerCompute implements Compute {
  readonly kind: ComputeKind = "firecracker";
  readonly capabilities: ComputeCapabilities = {
    snapshot: true,
    pool: true,
    networkIsolation: true,
    provisionLatency: "seconds",
  };

  private deps: FirecrackerComputeDeps;
  /** vmId -> live VM handle. Needed so start/stop/destroy/snapshot can find
   *  the object we created in provision() without re-spawning firecracker. */
  private vms = new Map<string, FirecrackerVm>();

  constructor(
    private readonly app: AppContext,
    deps?: Partial<FirecrackerComputeDeps>,
  ) {
    this.deps = deps ? { ...productionDeps, ...deps } : productionDeps;
  }

  /** Test-only: swap one or more deps post-construction. */
  setDepsForTesting(partial: Partial<FirecrackerComputeDeps>): void {
    this.deps = { ...this.deps, ...partial };
  }

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    const availability = this.deps.isFirecrackerAvailable();
    if (!availability.ok) {
      throw new Error(
        `Firecracker compute unavailable: ${availability.reason ?? "unknown reason"}. ` +
          "Firecracker requires a Linux host with /dev/kvm; on macOS fall back to " +
          "ec2-firecracker or use a Linux VM.",
      );
    }

    const name = (opts.tags?.name as string | undefined) ?? `fc-${randomSuffix()}`;
    const vmId = `ark-fc-${name}`;
    const tapName = `fc-${vmId}`.slice(0, 15); // Linux IFNAMSIZ=16, -1 for NUL

    // 1. Kernel + rootfs (cached under ~/.ark/firecracker/).
    const artifacts = await this.deps.ensureRootfs();

    // 2. Host networking. ensureBridge + createTap + assignGuestIp produce
    //    a /30 where host is .1 and guest is .2. We pass those addresses to
    //    the guest via the kernel boot args so networking is up by the time
    //    arkd binds (no DHCP round-trip).
    await this.deps.ensureBridge(BRIDGE_NAME);
    await this.deps.createTap(tapName, BRIDGE_NAME);
    let guestAddr;
    try {
      guestAddr = await this.deps.assignGuestIp(tapName);
    } catch (err) {
      // If IP assignment fails, clean up the TAP we just made so the next
      // attempt isn't blocked by a stale device.
      await safe(async () => this.deps.removeTap(tapName));
      throw err;
    }

    // 3. Construct + start the VM.
    const bootArgs = [
      "console=ttyS0",
      "reboot=k",
      "panic=1",
      "pci=off",
      // Static-config the guest NIC via the kernel's built-in `ip=` parser.
      // `ip=<client>::<gw>:<mask>::<iface>:off`. Using `off` disables DHCP
      // so boot is deterministic; gw is the host side of the /30.
      `ip=${guestAddr.guestIp}::${guestAddr.hostIp}:${guestAddr.mask}::eth0:off`,
    ].join(" ");

    const vm = this.deps.createVm({
      id: vmId,
      kernelPath: artifacts.kernelPath,
      rootfsPath: artifacts.rootfsPath,
      networkTapName: tapName,
      bootArgs,
      vcpuCount: parseVcpus(opts.size),
      memMib: parseMem(opts.size),
    });

    try {
      await vm.start();
    } catch (err) {
      // Undo network setup on boot failure so we don't leak TAPs.
      await safe(async () => vm.stop());
      await safe(async () => this.deps.removeTap(tapName));
      throw err;
    }

    // 4. Wait for arkd inside the VM. Polling over the bridge from the host.
    const arkdUrl = `http://${guestAddr.guestIp}:${GUEST_ARKD_PORT}`;
    try {
      await this.deps.waitForArkdReady(arkdUrl, ARKD_READY_TIMEOUT_MS);
    } catch (err) {
      await safe(async () => vm.stop());
      await safe(async () => this.deps.removeTap(tapName));
      throw new Error(
        `Firecracker VM booted but arkd did not come ready at ${arkdUrl} within ` +
          `${ARKD_READY_TIMEOUT_MS}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.vms.set(vmId, vm);

    const meta: FirecrackerMeta = {
      vmId,
      socketPath: vm.socketPath,
      guestIp: guestAddr.guestIp,
      hostIp: guestAddr.hostIp,
      tapName,
      kernelPath: artifacts.kernelPath,
      rootfsPath: artifacts.rootfsPath,
      arkdUrl,
    };

    opts.onLog?.(`firecracker: VM ${vmId} ready at ${arkdUrl}`);

    return {
      kind: this.kind,
      name,
      meta: { firecracker: meta },
    };
  }

  /** Resume a paused VM. If we don't have a live handle (e.g. after a
   *  process restart) we treat it as a no-op -- start semantics for a brand
   *  new VM belong in `provision`. */
  async start(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    const vm = this.vms.get(meta.vmId);
    if (!vm) return;
    await vm.resume();
  }

  /** Pause the VM (suspends vCPUs, keeps memory). Full teardown is `destroy`. */
  async stop(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    const vm = this.vms.get(meta.vmId);
    if (!vm) return;
    await vm.pause();
  }

  /**
   * Terminate the VM, remove the TAP device, drop the live handle. The
   * per-VM work dir is left on disk so crash dumps + snapshots survive a
   * destroy; a future `gc` pass reaps them by age.
   */
  async destroy(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    const vm = this.vms.get(meta.vmId);
    if (vm) {
      await safe(async () => vm.stop());
      this.vms.delete(meta.vmId);
    }
    await safe(async () => this.deps.removeTap(meta.tapName));
  }

  getArkdUrl(h: ComputeHandle): string {
    return readMeta(h).arkdUrl;
  }

  /**
   * Snapshot via the VM manager's Pause + /snapshot/create. Returns a
   * `Snapshot` whose `metadata.artifacts` carries the on-disk paths so
   * `restore` can find them without us maintaining a separate index.
   *
   * The VM remains Paused after this call (Firecracker semantics); callers
   * that want the VM to keep running should issue a `start(h)` after.
   */
  async snapshot(h: ComputeHandle): Promise<Snapshot> {
    if (!this.capabilities.snapshot) throw new NotSupportedError(this.kind, "snapshot");
    const meta = readMeta(h);
    const vm = this.vms.get(meta.vmId);
    if (!vm) throw new Error(`Firecracker VM not live for snapshot: ${meta.vmId}`);

    const paths = vmSnapshotPaths(meta.vmId);
    const artifacts = await vm.snapshot(paths);
    const sizeBytes = await fileSize(artifacts.memFilePath).catch(() => 0);

    return {
      id: `fc-${meta.vmId}-${Date.now()}`,
      computeKind: this.kind,
      createdAt: new Date().toISOString(),
      sizeBytes,
      metadata: {
        vmId: meta.vmId,
        tapName: meta.tapName,
        kernelPath: meta.kernelPath,
        rootfsPath: meta.rootfsPath,
        artifacts,
      },
    };
  }

  /**
   * Restore from a previously-taken snapshot. We re-ensure the TAP (it may
   * have been torn down during the pause window) and spawn a fresh
   * firecracker process bound to the same vmId so the work dir + socket
   * paths match what the snapshot was taken against.
   *
   * If the ARP cache has been flushed we also re-assign the /30 -- the
   * host-side IP on the TAP survives `ip link delete` only if the TAP does,
   * so idempotent re-assign is the safe choice.
   */
  async restore(s: Snapshot): Promise<ComputeHandle> {
    if (!this.capabilities.snapshot) throw new NotSupportedError(this.kind, "restore");
    if (s.computeKind !== this.kind) {
      throw new Error(`Snapshot is for ${s.computeKind}, cannot restore into ${this.kind}`);
    }
    const metaAny = s.metadata as Record<string, unknown>;
    const vmId = metaAny.vmId as string;
    const tapName = metaAny.tapName as string;
    const kernelPath = metaAny.kernelPath as string;
    const rootfsPath = metaAny.rootfsPath as string;
    const artifacts = metaAny.artifacts as { memFilePath: string; stateFilePath: string };
    if (!vmId || !tapName || !kernelPath || !rootfsPath || !artifacts) {
      throw new Error("Snapshot metadata is missing required fields");
    }

    await this.deps.ensureBridge(BRIDGE_NAME);
    // createTap errors if the TAP exists; caller deleted it during snapshot?
    // We best-effort: try to create; swallow "already exists" by catching.
    await safe(async () => this.deps.createTap(tapName, BRIDGE_NAME));
    const guestAddr = await this.deps.assignGuestIp(tapName);

    const vm = this.deps.createVm({
      id: vmId,
      kernelPath,
      rootfsPath,
      networkTapName: tapName,
    });
    await vm.restore(artifacts);
    this.vms.set(vmId, vm);

    // Seed the work dir so vmSnapshotPaths(vmId) still resolves for future
    // snapshot calls.
    vmWorkDir(vmId);

    const arkdUrl = `http://${guestAddr.guestIp}:${GUEST_ARKD_PORT}`;
    // Give the restored guest a brief window to re-bind arkd. A restored
    // snapshot picks up at the instruction after /snapshot/create; arkd
    // should still be bound, but a socket timing-out is possible on a
    // machine under load. We use the same readiness poll as cold boot.
    await this.deps.waitForArkdReady(arkdUrl, ARKD_READY_TIMEOUT_MS);

    const meta: FirecrackerMeta = {
      vmId,
      socketPath: vm.socketPath,
      guestIp: guestAddr.guestIp,
      hostIp: guestAddr.hostIp,
      tapName,
      kernelPath,
      rootfsPath,
      arkdUrl,
    };

    return {
      kind: this.kind,
      name: vmId.replace(/^ark-fc-/, ""),
      meta: { firecracker: meta },
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read the firecracker slot from a handle's meta. Centralised so every
 * caller produces the same "meta shape unexpected" error string.
 */
function readMeta(h: ComputeHandle): FirecrackerMeta {
  const slot = (h.meta as { firecracker?: FirecrackerMeta }).firecracker;
  if (!slot) {
    throw new Error(`Firecracker handle.meta.firecracker missing; got keys: [${Object.keys(h.meta).join(", ")}]`);
  }
  return slot;
}

/** Best-effort async action; swallows errors. Used in teardown paths. */
async function safe(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    logInfo("compute", "intentional");
  }
}

/**
 * Parse a `size` hint like "small" / "2x4" (2 vcpu, 4 GiB) into vcpus. The
 * hint is entirely optional and informal for now; a structured size enum
 * lands with the pool layer.
 */
function parseVcpus(size: string | undefined): number {
  if (!size) return 2;
  const m = size.match(/^(\d+)x\d+$/i);
  if (m) return Math.max(1, Math.min(16, parseInt(m[1], 10)));
  if (/small/i.test(size)) return 2;
  if (/medium/i.test(size)) return 4;
  if (/large/i.test(size)) return 8;
  return 2;
}

function parseMem(size: string | undefined): number {
  if (!size) return 1024;
  const m = size.match(/^\d+x(\d+)$/i);
  if (m) return Math.max(256, parseInt(m[1], 10) * 1024);
  if (/small/i.test(size)) return 1024;
  if (/medium/i.test(size)) return 2048;
  if (/large/i.test(size)) return 4096;
  return 1024;
}

/**
 * Default readiness polling against the guest arkd. We hit `/snapshot`
 * rather than `/health` because arkd exposes /snapshot as its canonical
 * "ready to serve" endpoint today and we don't want to add a new one from
 * this module.
 *
 * Any 2xx OR 4xx response counts as "arkd is alive" -- a 4xx means arkd is
 * listening and replied with "method/shape not supported", which is good
 * enough for a readiness probe. Network errors and 5xx keep the poll going
 * until the deadline.
 */
async function defaultWaitForArkdReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/snapshot`, { method: "GET" });
      if (res.status < 500) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(ARKD_POLL_INTERVAL_MS);
  }
  throw new Error(`arkd readiness timeout at ${url}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fileSize(path: string): Promise<number> {
  const { stat } = await import("fs/promises");
  const s = await stat(path);
  return s.size;
}

/** Short random suffix for VM names when the caller doesn't supply one. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Convenience registration helper -- called from `AppContext.boot` once the
 * availability probe confirms the host supports Firecracker. Kept here so
 * the app.ts registration block stays short.
 */
export function registerFirecrackerIfAvailable(app: AppContext): FirecrackerCompute | null {
  const avail = isFirecrackerAvailable();
  if (!avail.ok) {
    logInfo("compute", "firecracker compute registration skipped", {
      reason: avail.reason ?? "unknown",
      platform: avail.details?.platform,
    });
    return null;
  }
  const compute = new FirecrackerCompute(app);
  app.registerCompute(compute);
  logInfo("compute", "firecracker compute registered", {
    platform: avail.details?.platform,
  });
  return compute;
}
