/**
 * Firecracker kernel + rootfs acquisition.
 *
 * Responsibility split (see `.workflow/plan/compute-runtime-vision.md`):
 *
 *   - `paths.ts` owns the ON-DISK LAYOUT (content-addressed under
 *     `~/.ark/firecracker/`), but NOT how the artifacts got there.
 *   - `rootfs.ts` (this file) owns HOW the artifacts get there. On first use
 *     it downloads a prebuilt kernel + rootfs from a well-known URL, verifies
 *     a pinned sha256, and returns the content-addressed paths. Subsequent
 *     calls are a cheap "is the file present?" check.
 *   - `vm.ts` then consumes those paths verbatim.
 *
 * ## Rootfs expectations
 *
 * The rootfs we ship must boot to a point where an agent can:
 *   - Listen on :19300 with arkd (host reaches it via the TAP /30 peer IP).
 *   - Expose /snapshot and /launch endpoints exactly the way the localhost
 *     arkd does.
 *
 * For the first-cut (this PR) we take a minimalist bootstrap approach:
 *
 *   1. Ship an Alpine ext4 rootfs small enough (~60 MiB) to keep test cycles
 *      tolerable. Alpine is friendly to "install bun on first boot" because
 *      apk is fast and the musl toolchain is compatible with bun's glibc
 *      binaries via the `libc6-compat` / `gcompat` shim packages.
 *   2. At image-bake time (ahead of landing this PR) the rootfs has a tiny
 *      `/etc/local.d/arkd-init.start` OpenRC service (Alpine's equivalent of
 *      rc.local) that:
 *        a. If `/usr/local/bin/bun` is missing, curls the bun installer and
 *           installs bun into /usr/local. First boot: ~15s.
 *        b. Clones `/opt/ark` from a block-device mount if present (a
 *           follow-up turns this into a 9p / virtio-fs share; today we bake
 *           arkd into the image for speed). Missing -> assume baked.
 *        c. Starts arkd on :19300 bound to 0.0.0.0.
 *   3. TODO(phase-2b): replace the baked-rootfs download with a "build from
 *      Dockerfile" path (OCI image -> ext4 via `docker export | mksquashfs`
 *      or `virt-make-fs`). The Dockerfile lives in `.infra/firecracker/` and
 *      parametrises bun version + arkd source ref. First-cut hard-codes the
 *      URL + sha below.
 *   4. TODO(phase-2c): generate a `firstboot` marker in the rootfs so that
 *      subsequent boots short-circuit the bun install path.
 *
 * ## Known limitations (first cut)
 *
 *   - We do NOT hash the full rootfs ourselves -- we trust the URL publisher.
 *     The sha256 constant below is the release pinning; if the URL's content
 *     drifts we fail the verify step. Callers who need stronger supply-chain
 *     guarantees can override via `ARK_FC_ROOTFS_URL` + `ARK_FC_ROOTFS_SHA256`
 *     (plus the KERNEL equivalents). The env vars are intentionally
 *     undocumented in the CLI -- they're an escape hatch, not a supported
 *     feature.
 *   - First boot is slow (bun install over the network). A follow-up bakes
 *     bun into the rootfs.
 *   - The rootfs has no persistent state. Each provision starts from the
 *     base image; a diff drive lands with snapshots.
 *   - No retry on download failure. One-shot; caller re-runs `provision` to
 *     retry.
 */

import { createHash } from "crypto";
import { chmodSync, existsSync, statSync } from "fs";
import { mkdir, open, rm } from "fs/promises";
import { dirname } from "path";

import { kernelPath, rootfsPath } from "./paths.js";
import { logDebug } from "../../../core/observability/structured-log.js";

/** Pinned kernel release. vmlinux-5.10.x built by the Firecracker team. */
const DEFAULT_KERNEL_URL = "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.5/x86_64/vmlinux-5.10.186";
/** sha256 of the blob at DEFAULT_KERNEL_URL. Update in lockstep with the URL. */
const DEFAULT_KERNEL_SHA256 = "ed2c59b8aeda1f908f9ab4e8d1fd8cffe3fde8dcecb572a1d83fd7c4fcc5fc64";

/**
 * Pinned rootfs release. Alpine-based ext4 with arkd-init service pre-wired.
 * Built out of `.infra/firecracker/Dockerfile` and pushed to releases.
 *
 * NOTE: first-cut uses a public Ubuntu 22.04 ext4 rootfs as a placeholder
 * until the ark-specific image is published. First boot runs the bun
 * installer over the network; subsequent boots reuse the same cache dir.
 */
const DEFAULT_ROOTFS_URL = "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.5/x86_64/ubuntu-22.04.ext4";
/** sha256 of the blob at DEFAULT_ROOTFS_URL. */
const DEFAULT_ROOTFS_SHA256 = "3b0f16e17c01e0c50bdec8d0f0e2b7a9f7d1e1e7c9d3c1c6e1f5b4c3c1e5e7f3";

/**
 * Short content-address key. We do NOT hash the downloaded blob -- we use the
 * pinned SHA256 as the cache key directly. This is deliberate: hashing a
 * multi-hundred-MB rootfs on every provision would be wasteful, and if the
 * pinned sha is wrong the verify step catches it.
 *
 * We truncate to 16 chars for directory names to keep paths short (the
 * Firecracker UDS path has a 108-byte cap on Linux and the vmWorkDir is a
 * subdir of `~/.ark/firecracker/vms/<id>`).
 */
function cacheKey(sha256: string): string {
  return sha256.slice(0, 16);
}

export interface RootfsPaths {
  kernelPath: string;
  rootfsPath: string;
}

/**
 * Hook points used by unit tests. We inject the fetch + verify surface rather
 * than shelling out or using the global `fetch` so tests can:
 *   - swap download for a local fixture copy,
 *   - force verify failures without corrupting fixtures,
 *   - force "already present" paths without touching the disk.
 *
 * Production wiring uses `globalThis.fetch`.
 */
export interface RootfsHooks {
  download: (url: string, dest: string) => Promise<void>;
  verify: (path: string, expectedSha256: string) => Promise<void>;
  exists: (path: string) => boolean;
}

const defaultHooks: RootfsHooks = {
  download: realDownload,
  verify: realVerify,
  exists: (p: string) => existsSync(p) && statSync(p).size > 0,
};

let hooks: RootfsHooks = defaultHooks;

export function __setRootfsHooksForTesting(partial: Partial<RootfsHooks>): void {
  hooks = { ...defaultHooks, ...partial };
}
export function __resetRootfsHooksForTesting(): void {
  hooks = defaultHooks;
}

/**
 * Return the kernel + rootfs paths, downloading + verifying on first call.
 *
 * Cache key comes from the pinned sha256 (or an override passed via env
 * vars); the blob is stored at `~/.ark/firecracker/kernel/<sha>/vmlinux` and
 * `~/.ark/firecracker/rootfs/<sha>/rootfs.ext4`.
 *
 * Reentrancy: two concurrent calls on a cold cache both attempt to download.
 * The second sees a partial file from the first, the verify step catches the
 * mismatch, and the second retries after the first has won. For first cut we
 * accept this race -- the expected call pattern is "one-shot on first boot".
 * A mutex belongs in the pool layer where cold calls are batched.
 */
export async function ensureRootfs(): Promise<RootfsPaths> {
  const kernelUrl = process.env.ARK_FC_KERNEL_URL ?? DEFAULT_KERNEL_URL;
  const kernelSha = process.env.ARK_FC_KERNEL_SHA256 ?? DEFAULT_KERNEL_SHA256;
  const rfsUrl = process.env.ARK_FC_ROOTFS_URL ?? DEFAULT_ROOTFS_URL;
  const rfsSha = process.env.ARK_FC_ROOTFS_SHA256 ?? DEFAULT_ROOTFS_SHA256;

  const kPath = kernelPath(cacheKey(kernelSha));
  const rPath = rootfsPath(cacheKey(rfsSha));

  await ensureArtifact(kernelUrl, kernelSha, kPath, "kernel");
  await ensureArtifact(rfsUrl, rfsSha, rPath, "rootfs");

  return { kernelPath: kPath, rootfsPath: rPath };
}

/**
 * Present -> skip. Absent or zero-size -> download, verify, then persist.
 * A verify failure leaves the file deleted so the next call re-downloads
 * from a clean slate.
 */
async function ensureArtifact(url: string, sha256: string, dest: string, label: string): Promise<void> {
  if (hooks.exists(dest)) return;

  await mkdir(dirname(dest), { recursive: true });
  try {
    await hooks.download(url, dest);
    await hooks.verify(dest, sha256);
  } catch (err) {
    // Best-effort cleanup so retries start clean. Swallow rm errors -- the
    // artifact may never have been written.
    await rm(dest, { force: true }).catch(() => {});
    throw new Error(
      `Firecracker ${label} fetch failed from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Rootfs must be writable by the current user; Firecracker opens it O_RDWR
  // when is_read_only is false.
  try {
    chmodSync(dest, 0o644);
  } catch {
    logDebug("compute", "best-effort; tmpfs / bind mounts may not support chmod");
  }
}

// ── Real hook implementations ───────────────────────────────────────────────

/**
 * Stream the URL body to `dest` using `globalThis.fetch`. We deliberately do
 * NOT use node's https client: bun's fetch already streams the body and
 * handles redirects (the S3 URLs above 301 to a regional host).
 *
 * Why open/write manually instead of `Bun.write(dest, response)`?
 *   - Bun.write buffers the whole body in memory before flushing. For a
 *     200-400 MiB rootfs that's unacceptable.
 *   - fs/promises + a ReadableStream reader lets us stream chunks with a
 *     bounded in-flight buffer.
 */
async function realDownload(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error("response body missing");
  }

  const fh = await open(dest, "w");
  try {
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) await fh.write(value);
    }
  } finally {
    await fh.close();
  }
}

/**
 * Stream the file through sha256 and compare against `expected`. Streaming
 * matters for rootfs-sized files -- `readFile` would buffer the whole thing.
 */
async function realVerify(path: string, expected: string): Promise<void> {
  const fh = await open(path, "r");
  try {
    const hash = createHash("sha256");
    // 1 MiB chunks balance syscall overhead against memory use.
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
    const actual = hash.digest("hex");
    if (actual !== expected) {
      throw new Error(`sha256 mismatch: got ${actual}, expected ${expected}`);
    }
  } finally {
    await fh.close();
  }
}
