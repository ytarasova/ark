/**
 * Firecracker guest networking via TAP devices attached to a Linux bridge.
 *
 * Firecracker itself only knows how to accept a host-side TAP device name
 * (`host_dev_name`) and a MAC address; it does NOT configure routing for
 * the guest. The usual pattern is:
 *
 *   1. Host has a Linux bridge (say `arkbr0`) with its own /24 address.
 *   2. Each VM gets a TAP device (`fc-<id>`) enslaved to that bridge.
 *   3. Host assigns a /30 to the TAP itself (point-to-point with the guest).
 *      The guest's `/30` peer becomes the agent IP reachable from the host.
 *   4. Guest-side config (IP/mask/gateway) is NOT Firecracker's job -- it's
 *      configured either via kernel boot args (`ip=...`) or cloud-init.
 *      We return the chosen addresses so the caller can bake them into the
 *      boot args.
 *
 * All operations shell out to `ip` from iproute2. They are idempotent where
 * it makes sense: `ensureBridge` will not error if the bridge exists, and
 * `removeTap` swallows "Cannot find device" errors. Commands that fail with
 * an unexpected status throw; callers catch these and surface them.
 *
 * None of this works on macOS. Callers must gate on `isFirecrackerAvailable`
 * before touching this module.
 */

import { spawn } from "child_process";

/** Subnet pool. /30 gives exactly 2 usable host addresses -- host + guest. */
const POOL_PREFIX = "192.168.127"; // documented in the public interface; change invalidates callers
const POOL_MASK = "30";

/** Run `ip <args>` and reject with a descriptive error if exit code != 0. */
async function ipCmd(args: string[], opts: { allowFailure?: (stderr: string) => boolean } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // Not using Bun.spawn here: this module also has to work under Node for
    // unit tests that stub `ip` via a PATH override, and Bun.spawn's behavior
    // around stdio redirection is harder to stub without a full harness.
    const cp = spawn("ip", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    cp.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    cp.on("error", reject);
    cp.on("close", (code: number | null) => {
      if (code === 0) return resolve();
      if (opts.allowFailure && opts.allowFailure(stderr)) return resolve();
      reject(new Error(`ip ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Create (if missing) a Linux bridge and bring it up. Idempotent.
 *
 * If the bridge already exists, `ip link add` exits with code 2 and stderr
 * "RTNETLINK answers: File exists" -- we treat that as success. `ip link
 * set up` is always safe to re-run.
 */
export async function ensureBridge(name: string): Promise<void> {
  await ipCmd(["link", "add", "name", name, "type", "bridge"], {
    allowFailure: (stderr) => /File exists/i.test(stderr),
  });
  await ipCmd(["link", "set", name, "up"]);
}

/**
 * Create a TAP device owned by the current user, attach it to `bridge`, bring
 * it up. The TAP must not already exist -- callers that reuse names should
 * call `removeTap` first.
 *
 * We pass `multi_queue` only when it becomes a requirement (multi-vcpu TX
 * throughput). Default single-queue is fine for the agent workload.
 */
export async function createTap(name: string, bridge: string): Promise<void> {
  await ipCmd(["tuntap", "add", "dev", name, "mode", "tap"]);
  await ipCmd(["link", "set", name, "master", bridge]);
  await ipCmd(["link", "set", name, "up"]);
}

/**
 * Remove a TAP device. Safe to call even if the device never existed -- the
 * "Cannot find device" error from `ip link delete` is swallowed so teardown
 * paths can be unconditional.
 */
export async function removeTap(name: string): Promise<void> {
  await ipCmd(["link", "delete", name], {
    allowFailure: (stderr) => /Cannot find device/i.test(stderr) || /does not exist/i.test(stderr),
  });
}

export interface GuestAddr {
  /** Host side of the /30; assigned to the TAP device. */
  hostIp: string;
  /** Guest side of the /30; the VM should configure this as its primary IP. */
  guestIp: string;
  /** Netmask (dotted quad) matching the /30. */
  mask: string;
  /** CIDR prefix length for convenience (always 30). */
  prefixLen: number;
}

/**
 * Pick a /30 subnet from `192.168.127.0/24` deterministically derived from
 * the TAP name, configure the host side on the TAP, and return both
 * addresses.
 *
 * A /30 has 4 addresses: network, host, guest, broadcast. We pick address .1
 * as the host and .2 as the guest of each /30 block. The /24 pool fits 64
 * non-overlapping /30s (indices 0..63), which is ample for the local pool.
 *
 * Derivation:
 *   index = hash(tapName) mod 64
 *   block = index * 4
 *   hostIp  = 192.168.127.(block + 1)
 *   guestIp = 192.168.127.(block + 2)
 *
 * Caveat -- hash collisions: two TAPs with different names can hash to the
 * same block and fight for addresses. We deliberately accept that here to
 * keep the manager stateless; an allocator that dispenses unique indices
 * belongs in the pool layer. Callers that need stability beyond
 * best-effort must coordinate externally.
 *
 * We only configure the HOST side of the /30. The caller is responsible for
 * giving the guest its IP, typically via kernel `ip=<guestIp>::<hostIp>:<mask>`
 * boot args or a cloud-init network stanza.
 */
export async function assignGuestIp(tap: string): Promise<GuestAddr> {
  const index = hashName(tap) % 64;
  const block = index * 4;
  const hostIp = `${POOL_PREFIX}.${block + 1}`;
  const guestIp = `${POOL_PREFIX}.${block + 2}`;
  const mask = "255.255.255.252"; // /30
  const prefixLen = 30;

  // Idempotent: if we re-run on the same TAP, `addr add` returns "File
  // exists" for an already-assigned address.
  await ipCmd(["addr", "add", `${hostIp}/${POOL_MASK}`, "dev", tap], {
    allowFailure: (stderr) => /File exists/i.test(stderr),
  });

  return { hostIp, guestIp, mask, prefixLen };
}

/**
 * Deterministic, stable string hash. NOT cryptographic -- we only need it to
 * spread TAP names across 64 blocks without systematic collisions on common
 * patterns like `fc-<incrementing-id>`.
 *
 * djb2: classic, branch-free, sufficient for this coverage. Bitwise ops
 * coerce to 32-bit int in V8/JSC; take the absolute value before the modulo
 * to keep the result non-negative across all inputs.
 */
function hashName(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
