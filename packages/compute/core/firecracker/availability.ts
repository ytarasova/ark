/**
 * Firecracker availability probe.
 *
 * Firecracker has hard platform requirements:
 *   - Linux kernel 4.14+ (we only check `platform() === "linux"`; kernel
 *     version checks are brittle and the binary itself will fail cleanly
 *     if the host is too old).
 *   - `/dev/kvm` present and readable by the current user. On most distros
 *     this means the user is in the `kvm` group. The file existing but not
 *     being readable is a common foot-gun, so we explicitly check access().
 *   - `firecracker` binary on PATH (or at the default Firecracker release
 *     location; we only check PATH here -- callers can pass an absolute
 *     binary path via FirecrackerVmSpec in the future).
 *   - `ip` from iproute2 for TAP/bridge setup. Busybox `ip` is acceptable
 *     but unusual; we only verify the command resolves.
 *
 * This function is explicitly non-throwing. Callers (Phase 2
 * FirecrackerCompute, or the CLI probe command) need to make scheduling
 * decisions based on the result -- on macOS for example we fall back to
 * Docker, not crash.
 */

import { accessSync, constants as fsConstants } from "fs";
import { platform } from "os";
import { delimiter, join } from "path";

export interface AvailabilityResult {
  ok: boolean;
  reason?: string;
  /** Populated even when ok=false, for diagnostics. */
  details?: {
    platform: string;
    kvm: "ok" | "missing" | "unreadable";
    firecrackerBinary: string | null;
    ipBinary: string | null;
  };
}

/**
 * Probe the host for Firecracker readiness. Never throws.
 *
 * Errors from any individual check are swallowed into a false `ok` with a
 * human-readable `reason`. Each failure mode returns as early as possible so
 * the first missing dependency is the one reported (least confusing for a
 * user fixing their box step by step).
 */
export function isFirecrackerAvailable(): AvailabilityResult {
  const plat = platform();
  const details = {
    platform: plat,
    kvm: "missing" as "ok" | "missing" | "unreadable",
    firecrackerBinary: null as string | null,
    ipBinary: null as string | null,
  };

  if (plat !== "linux") {
    return { ok: false, reason: `Firecracker requires Linux with KVM; detected ${plat}`, details };
  }

  // /dev/kvm must both exist and be readable by the current user. We check
  // R_OK|W_OK: Firecracker needs write access to the KVM ioctl fd, not just
  // read. If the file exists but is 0600 root:root the user is typically in
  // the wrong group.
  try {
    accessSync("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
    details.kvm = "ok";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      details.kvm = "missing";
      return {
        ok: false,
        reason: "/dev/kvm not found. KVM not loaded or host lacks virtualization support.",
        details,
      };
    }
    details.kvm = "unreadable";
    return {
      ok: false,
      reason: "/dev/kvm exists but is not readable/writable by the current user. Add user to the 'kvm' group.",
      details,
    };
  }

  const firecracker = findOnPath("firecracker");
  details.firecrackerBinary = firecracker;
  if (!firecracker) {
    return {
      ok: false,
      reason:
        "firecracker binary not found in PATH. Install from https://github.com/firecracker-microvm/firecracker/releases.",
      details,
    };
  }

  const ip = findOnPath("ip");
  details.ipBinary = ip;
  if (!ip) {
    return { ok: false, reason: "iproute2 `ip` command not found. Install package 'iproute2'.", details };
  }

  return { ok: true, details };
}

/**
 * Resolve a binary by walking PATH. We avoid `which` (not portable -- Alpine
 * images ship without it) and avoid spawning a subprocess for a check that
 * runs on every boot. Uses the synchronous FS API because this probe is
 * called from code paths that are themselves synchronous (capability probes
 * at module load time).
 */
function findOnPath(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not in this PATH entry; keep looking
    }
  }
  return null;
}
