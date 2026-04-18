/**
 * Firecracker VM lifecycle manager.
 *
 * This module is a pure, self-contained wrapper over the Firecracker API
 * socket. It knows how to:
 *
 *   - Spawn a `firecracker` process bound to a unix domain socket.
 *   - Speak HTTP/1.1 over that socket (Firecracker does not support TCP).
 *   - Configure boot-source, drives, machine-config, network interfaces.
 *   - Issue InstanceStart, Pause, Resume.
 *   - Snapshot and restore using Firecracker's native snapshot API.
 *
 * It does NOT know about:
 *   - the ark Compute interface (Phase 2 wraps this from `FirecrackerCompute`),
 *   - networking host-side setup (see `network.ts`),
 *   - kernel/rootfs acquisition (see `paths.ts`, plus a future image module).
 *
 * ## Why raw `node:net` instead of `undici` or `fetch`?
 *
 * Bun's `fetch` cannot target a unix socket. `undici` can, but pulling it in
 * as a dep for 200 lines of simple request/response plumbing doesn't pay.
 * Firecracker's API is trivial HTTP/1.1 -- headers, body, status line. We
 * write a minimal request-response client below. All responses are either
 * 204 (No Content) or `application/json`; no chunked encoding, no keep-alive
 * semantics required (we open a fresh connection per request, as the
 * Firecracker docs explicitly recommend for simplicity).
 *
 * ## Why not keep-alive?
 *
 * Firecracker's HTTP server is single-threaded and single-connection; there
 * is no throughput advantage to pipelining API calls, and keeping a socket
 * open through a Pause/Resume cycle is fragile. One connection per call
 * avoids the lifecycle concerns entirely.
 */

import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { createConnection, type Socket } from "net";
import { existsSync } from "fs";
import { open } from "fs/promises";

import { vmSocketPath, vmLogPath, vmWorkDir } from "./paths.js";

export interface FirecrackerVmSpec {
  id: string;
  kernelPath: string;
  rootfsPath: string;
  readOnlyRootfs?: boolean;
  vcpuCount?: number;
  memMib?: number;
  networkTapName?: string;
  extraDrives?: Array<{ path: string; driveId: string; readOnly: boolean }>;
  bootArgs?: string;
}

export interface SnapshotOpts {
  memFilePath: string;
  stateFilePath: string;
  snapshotType?: "Full" | "Diff";
}

export interface SnapshotArtifacts {
  memFilePath: string;
  stateFilePath: string;
}

export interface FirecrackerVm {
  readonly spec: FirecrackerVmSpec;
  readonly socketPath: string;
  readonly pid: number | null;

  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  snapshot(opts: SnapshotOpts): Promise<SnapshotArtifacts>;
  restore(from: SnapshotArtifacts): Promise<void>;
  getGuestIp(): Promise<string | null>;
}

/**
 * Hook points used by unit tests to stub subprocess spawning and the API
 * socket without requiring a real `firecracker` binary. These are module-
 * level rather than constructor args because the VM object exposes a
 * narrow public surface and we don't want to pollute it with test knobs.
 *
 * Tests call `__setFirecrackerHooksForTesting({...})` in `beforeEach` and
 * `__resetFirecrackerHooksForTesting()` in `afterEach`.
 */
interface Hooks {
  spawnFirecracker: (
    args: string[],
    socketPath: string,
    logPath: string,
  ) => { pid: number | null; process: ChildProcess | null };
  sendApiRequest: (socketPath: string, method: string, path: string, body?: unknown) => Promise<ApiResponse>;
  readArpTable: () => Promise<string>;
}

const defaultHooks: Hooks = {
  spawnFirecracker: realSpawnFirecracker,
  sendApiRequest: realSendApiRequest,
  readArpTable: realReadArpTable,
};

let hooks: Hooks = defaultHooks;

export function __setFirecrackerHooksForTesting(partial: Partial<Hooks>): void {
  hooks = { ...defaultHooks, ...partial };
}
export function __resetFirecrackerHooksForTesting(): void {
  hooks = defaultHooks;
}

/** Public factory -- only entry point into this module. */
export function createVm(spec: FirecrackerVmSpec): FirecrackerVm {
  return new FirecrackerVmImpl(spec);
}

class FirecrackerVmImpl implements FirecrackerVm {
  readonly spec: FirecrackerVmSpec;
  readonly socketPath: string;
  private child: ChildProcess | null = null;
  private _pid: number | null = null;

  constructor(spec: FirecrackerVmSpec) {
    this.spec = spec;
    // vmWorkDir() is called via vmSocketPath() which mkdir-p's the dir as
    // a side effect. Do this up-front so `start()` is purely network I/O.
    this.socketPath = vmSocketPath(spec.id);
    vmWorkDir(spec.id); // ensure subdirs exist before spawning
  }

  get pid(): number | null {
    return this._pid;
  }

  /**
   * Start the VM:
   *   1. Spawn firecracker with `--api-sock <path>`.
   *   2. Wait up to 5s for the API socket to appear (firecracker creates it
   *      after it finishes its startup handshake; this is the canonical
   *      "ready" signal -- no health endpoint exists pre-boot).
   *   3. PUT /boot-source with kernel + boot args.
   *   4. PUT /drives/rootfs and any extraDrives.
   *   5. PUT /machine-config (vcpus + mem).
   *   6. PUT /network-interfaces/eth0 if a TAP is configured.
   *   7. PUT /actions { action_type: "InstanceStart" }.
   *
   * Ordering matters: Firecracker rejects InstanceStart if boot-source or
   * rootfs is missing, and some drive validations only fire at start time.
   */
  async start(): Promise<void> {
    // Sanity-check sources eagerly so a typo produces a readable error here
    // instead of a cryptic Firecracker API 400 three calls later.
    if (!existsSync(this.spec.kernelPath)) {
      throw new Error(`Firecracker kernel not found: ${this.spec.kernelPath}`);
    }
    if (!existsSync(this.spec.rootfsPath)) {
      throw new Error(`Firecracker rootfs not found: ${this.spec.rootfsPath}`);
    }

    const logPath = vmLogPath(this.spec.id);
    const { pid, process: proc } = hooks.spawnFirecracker(
      ["--api-sock", this.socketPath, "--id", this.spec.id],
      this.socketPath,
      logPath,
    );
    this._pid = pid;
    this.child = proc;

    await waitForSocket(this.socketPath, 5_000);

    // --- boot-source -------------------------------------------------------
    const bootArgs = this.spec.bootArgs ?? "console=ttyS0 reboot=k panic=1 pci=off";
    await this.api("PUT", "/boot-source", {
      kernel_image_path: this.spec.kernelPath,
      boot_args: bootArgs,
    });

    // --- drives ------------------------------------------------------------
    // Root filesystem first so drive_id `rootfs` is always index 0.
    await this.api("PUT", "/drives/rootfs", {
      drive_id: "rootfs",
      path_on_host: this.spec.rootfsPath,
      is_root_device: true,
      is_read_only: this.spec.readOnlyRootfs === true,
    });
    for (const extra of this.spec.extraDrives ?? []) {
      await this.api("PUT", `/drives/${encodeURIComponent(extra.driveId)}`, {
        drive_id: extra.driveId,
        path_on_host: extra.path,
        is_root_device: false,
        is_read_only: extra.readOnly,
      });
    }

    // --- machine-config ----------------------------------------------------
    await this.api("PUT", "/machine-config", {
      vcpu_count: this.spec.vcpuCount ?? 2,
      mem_size_mib: this.spec.memMib ?? 1024,
      // smt: false intentionally omitted -- default matches host, and forcing
      // it off on hosts without SMT is a Firecracker 400.
    });

    // --- network -----------------------------------------------------------
    const tap = this.spec.networkTapName ?? `fc-${this.spec.id}`;
    // Firecracker requires a MAC or refuses. We derive it from the tap name
    // so two VMs on the same bridge don't collide; first byte 0xAA marks it
    // as locally-administered (bit 1 set, bit 0 clear -- unicast LAA).
    const mac = deriveMac(tap);
    await this.api("PUT", "/network-interfaces/eth0", {
      iface_id: "eth0",
      host_dev_name: tap,
      guest_mac: mac,
    });

    // --- start -------------------------------------------------------------
    await this.api("PUT", "/actions", { action_type: "InstanceStart" });
  }

  /**
   * Send SIGTERM, wait up to 5s for clean exit, then SIGKILL. Firecracker
   * handles SIGTERM by flushing and exiting -- no API equivalent. We don't
   * SendCtrlAltDel here because that triggers a graceful guest shutdown,
   * which for an agent VM is either pointless (nothing persistent in the
   * guest) or too slow (we want fast teardown after pool release).
   */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.killed) {
      this.child = null;
      return;
    }
    child.kill("SIGTERM");

    const killed = await waitForExit(child, 5_000);
    if (!killed) {
      child.kill("SIGKILL");
      await waitForExit(child, 2_000);
    }
    this.child = null;
  }

  /** Firecracker API Pause. Safe to call on an already-paused VM -- it 204s. */
  async pause(): Promise<void> {
    await this.api("PATCH", "/vm", { state: "Paused" });
  }

  /** Firecracker API Resume. */
  async resume(): Promise<void> {
    await this.api("PATCH", "/vm", { state: "Resumed" });
  }

  /**
   * Native Firecracker snapshot. The VM must be paused first; we do it here
   * so callers don't have to remember the two-step dance. The VM remains
   * paused after the snapshot -- caller resumes if desired.
   *
   * Both `memFilePath` and `stateFilePath` must be absolute paths on a
   * filesystem Firecracker can write to (i.e. not a read-only bind mount).
   */
  async snapshot(opts: SnapshotOpts): Promise<SnapshotArtifacts> {
    await this.pause();
    await this.api("PUT", "/snapshot/create", {
      snapshot_type: opts.snapshotType ?? "Full",
      snapshot_path: opts.stateFilePath,
      mem_file_path: opts.memFilePath,
    });
    return { memFilePath: opts.memFilePath, stateFilePath: opts.stateFilePath };
  }

  /**
   * Restore into a freshly spawned firecracker process. The caller should
   * have constructed this VM with the same `id` / tap / drive paths that
   * were live when the snapshot was taken -- Firecracker doesn't rewrite
   * them, and mismatches surface as network unreachable or disk I/O errors
   * inside the guest.
   *
   * After restore the VM is Paused; this method resumes it so the returned
   * state is symmetric with `start()`.
   */
  async restore(from: SnapshotArtifacts): Promise<void> {
    if (!existsSync(from.memFilePath)) {
      throw new Error(`snapshot memory file not found: ${from.memFilePath}`);
    }
    if (!existsSync(from.stateFilePath)) {
      throw new Error(`snapshot state file not found: ${from.stateFilePath}`);
    }

    const logPath = vmLogPath(this.spec.id);
    const { pid, process: proc } = hooks.spawnFirecracker(
      ["--api-sock", this.socketPath, "--id", this.spec.id],
      this.socketPath,
      logPath,
    );
    this._pid = pid;
    this.child = proc;

    await waitForSocket(this.socketPath, 5_000);

    await this.api("PUT", "/snapshot/load", {
      snapshot_path: from.stateFilePath,
      mem_backend: { backend_type: "File", backend_path: from.memFilePath },
      // resume_vm: omitted so the VM loads paused; we resume() below to
      // match `start()`'s "returns a running VM" contract.
    });
    await this.resume();
  }

  /**
   * Best-effort guest IP lookup via the host ARP table. Returns null while
   * the guest is still bringing up its interface (DHCP / static-config race).
   * Callers should poll with a short timeout rather than fail hard on null.
   *
   * We scan /proc/net/arp rather than shelling out to `ip neigh` because
   * the format is stable, parsing is trivial, and it's one fewer dependency
   * for tests to stub.
   */
  async getGuestIp(): Promise<string | null> {
    const tap = this.spec.networkTapName ?? `fc-${this.spec.id}`;
    let contents: string;
    try {
      contents = await hooks.readArpTable();
    } catch {
      return null;
    }
    // /proc/net/arp header:
    // IP address  HW type  Flags  HW address  Mask  Device
    const lines = contents.trim().split("\n").slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6) continue;
      const [ip, , flags, , , device] = parts;
      if (device !== tap) continue;
      // Flag 0x0 means incomplete ARP entry (no HW address yet).
      if (flags === "0x0") continue;
      return ip;
    }
    return null;
  }

  /** Typed API dispatch. Throws on non-2xx with the server's error body. */
  private async api(method: string, path: string, body?: unknown): Promise<ApiResponse> {
    const res = await hooks.sendApiRequest(this.socketPath, method, path, body);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Firecracker API ${method} ${path} -> ${res.status}: ${res.body}`);
    }
    return res;
  }
}

// ── low-level HTTP-over-unix-socket client ──────────────────────────────────

export interface ApiResponse {
  status: number;
  body: string;
}

async function realSendApiRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  return await new Promise<ApiResponse>((resolve, reject) => {
    let sock: Socket;
    try {
      sock = createConnection(socketPath);
    } catch (err) {
      reject(err);
      return;
    }

    let received = Buffer.alloc(0);
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };

    sock.on("connect", () => {
      const bodyStr = body === undefined ? "" : JSON.stringify(body);
      const bodyBuf = Buffer.from(bodyStr, "utf8");
      // Firecracker accepts HTTP/1.1 on its UDS. Host header is required by
      // the HTTP spec even though the server ignores it over UDS; we send
      // "localhost" for compatibility. Content-Type is only needed with a
      // body, but sending it always is harmless.
      const head =
        `${method} ${path} HTTP/1.1\r\n` +
        `Host: localhost\r\n` +
        `Accept: application/json\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${bodyBuf.length}\r\n` +
        `Connection: close\r\n\r\n`;
      sock.write(head);
      if (bodyBuf.length) sock.write(bodyBuf);
    });

    sock.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });
    sock.on("error", (err: Error) => done(() => reject(err)));
    sock.on("close", () => {
      if (settled) return;
      const parsed = parseHttpResponse(received.toString("utf8"));
      if (!parsed) {
        done(() => reject(new Error(`Firecracker API: invalid HTTP response (${received.length} bytes)`)));
        return;
      }
      done(() => resolve(parsed));
    });
  });
}

/**
 * Parse the raw response buffer into {status, body}. Good enough for
 * Firecracker's narrow response shapes (no chunked, no transfer-encoding
 * tricks). We find the `\r\n\r\n` header terminator, yank the status off
 * the first line, and return the rest as body.
 */
export function parseHttpResponse(raw: string): ApiResponse | null {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerBlock = raw.slice(0, headerEnd);
  const body = raw.slice(headerEnd + 4);
  const statusLine = headerBlock.split("\r\n", 1)[0] ?? "";
  const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
  if (!m) return null;
  return { status: parseInt(m[1], 10), body };
}

// ── subprocess + filesystem helpers (hookable for tests) ─────────────────────

function realSpawnFirecracker(
  args: string[],
  _socketPath: string,
  logPath: string,
): { pid: number | null; process: ChildProcess | null } {
  // We deliberately use node's child_process.spawn rather than Bun.spawn here
  // because:
  //   - Bun.spawn returns a Subprocess with a different shape than
  //     ChildProcess; we'd need a translation shim to expose kill() and exit
  //     events through a uniform interface.
  //   - Tests replace this whole function via Hooks, so Bun-specific perf
  //     doesn't matter.
  //
  // We pipe stdout/stderr rather than inherit or redirect-to-fd. A synchronous
  // fs.openSync would be fine but leaves cleanup awkward; instead we let
  // attachLogTee() open the log asynchronously and forward data chunks.
  const cp = nodeSpawn("firecracker", args, { stdio: ["ignore", "pipe", "pipe"], detached: false });
  attachLogTee(cp, logPath).catch(() => {
    /* log tee is best-effort */
  });
  return { pid: cp.pid ?? null, process: cp };
}

/**
 * Tee the firecracker child's stdout/stderr into a log file. We open the log
 * file in append mode so a restart doesn't clobber history, and attach
 * listeners to the child's streams. If stdio is "inherit" (as above), these
 * streams are null -- in that case this function is a no-op.
 */
async function attachLogTee(cp: ChildProcess, logPath: string): Promise<void> {
  if (!cp.stdout && !cp.stderr) return;
  const fh = await open(logPath, "a");
  const write = (data: Buffer | string) => {
    fh.write(typeof data === "string" ? Buffer.from(data) : data).catch(() => {
      /* log tee is best-effort */
    });
  };
  cp.stdout?.on("data", write);
  cp.stderr?.on("data", write);
  cp.on("close", () => {
    fh.close().catch(() => {
      /* best effort */
    });
  });
}

async function realReadArpTable(): Promise<string> {
  const fh = await open("/proc/net/arp", "r");
  try {
    const data = await fh.readFile({ encoding: "utf8" });
    return data;
  } finally {
    await fh.close();
  }
}

// ── polling helpers ──────────────────────────────────────────────────────────

/**
 * Poll for a unix socket file to appear. Firecracker creates the socket as
 * part of its startup; the existence of the file is a sufficient readiness
 * signal for subsequent API calls.
 */
async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(50);
  }
  throw new Error(`firecracker API socket did not appear within ${timeoutMs}ms: ${path}`);
}

async function waitForExit(cp: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (cp.exitCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    cp.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── misc ─────────────────────────────────────────────────────────────────────

/**
 * Derive a stable locally-administered MAC from a string. We set the LAA bit
 * (0x02) and clear the multicast bit (0x01) in the first byte, then fill the
 * remaining 5 bytes from a hash of the name.
 *
 * Deterministic MACs matter: snapshots capture the interface's MAC, and a
 * restore with a different MAC confuses the guest's network stack.
 */
export function deriveMac(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  }
  const bytes = [
    0xaa, // locally-administered, unicast
    (h >>> 24) & 0xff,
    (h >>> 16) & 0xff,
    (h >>> 8) & 0xff,
    h & 0xff,
    // 6th byte derived from length so names sharing a djb2 hash still differ
    name.length & 0xff,
  ];
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}
