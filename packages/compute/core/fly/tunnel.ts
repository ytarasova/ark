/**
 * Fly 6PN reachability tunnel -- `flyctl proxy` wrapper.
 *
 * Why this exists:
 *   `FlyMachinesCompute.getArkdUrl` returns `http://[<privateIp>]:19300`
 *   using the machine's 6PN IPv6 address. That URL is only reachable from
 *   inside Fly's private network. A local-dev or non-Fly control plane
 *   (anything running outside Fly's WireGuard mesh) cannot hit it.
 *
 *   `flyctl proxy` tunnels a local loopback port into 6PN via Fly's
 *   managed WireGuard gateway. We spawn one per machine, record the PID
 *   on `handle.meta.fly.tunnelPid`, and rewrite `getArkdUrl` to point at
 *   `http://localhost:<localPort>` when a tunnel is active.
 *
 * When to use the tunnel:
 *   - Local dev: `ARK_FLY_TUNNEL=1 ark session start ...`
 *   - Any non-Fly conductor (a bare EC2 box, a laptop, CI).
 *
 * Requirements:
 *   - `flyctl` binary on PATH (install: https://fly.io/docs/flyctl/install/)
 *   - Authenticated session: either `FLY_API_TOKEN` env var, or a prior
 *     `flyctl auth login`.
 *
 * Alternative -- run the conductor ON Fly itself:
 *   A conductor scheduled as a Fly machine reaches 6PN natively, no tunnel
 *   needed. See `docs/2026-04-18-CODE_INTELLIGENCE_DESIGN.md` Section 5
 *   ("Conductor pooling") for the eventual home of this topology.
 *
 * CLI syntax (verified against https://fly.io/docs/flyctl/proxy/):
 *   `fly proxy <local:remote> [remote_host] [-a <app>]`
 *   Positional `remote_host` accepts a Fly 6PN internal DNS name. We use
 *   `<machineId>.vm.<app>.internal` so the tunnel lands on one specific
 *   machine instead of whatever DNS returns first for the app.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { allocatePort as defaultAllocatePort } from "../../../core/config/port-allocator.js";

/** Default ready-probe deadline. arkd ships fast but the WireGuard handshake can take seconds. */
const DEFAULT_READY_TIMEOUT_MS = 10_000;
/** Poll interval while waiting for arkd to answer through the tunnel. */
const DEFAULT_READY_POLL_MS = 250;
/** Per-probe HTTP timeout. Each attempt is short so the overall deadline stays tight. */
const PROBE_HTTP_TIMEOUT_MS = 1_000;
/** How long we wait after SIGTERM before escalating to SIGKILL. */
const CLOSE_GRACE_MS = 2_000;

/** Minimal spawn signature the tunnel needs. Matches Node's `child_process.spawn`. */
export type SpawnFn = (command: string, args: ReadonlyArray<string>, options?: SpawnOptions) => ChildProcess;

/** Minimal fetch signature for probing the local port. Swappable in tests. */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Returned by `openFlyTunnel`. The caller is responsible for calling `close()`. */
export interface FlyTunnel {
  /** Host-side loopback port the tunnel is listening on. */
  localPort: number;
  /** PID of the backgrounded `flyctl proxy` process. */
  pid: number;
  /** SIGTERM, wait up to 2s, SIGKILL if still alive. Safe to call twice. */
  close(): Promise<void>;
}

export interface OpenFlyTunnelOpts {
  /** Fly app name (e.g. `ark-vm1`). */
  appName: string;
  /** Target machine id so the proxy pins to one machine. */
  machineId: string;
  /** Remote port inside the machine. arkd is always 19300. */
  remotePort: number;
  /** DI hook: spawn the child process. Defaults to `node:child_process#spawn`. */
  spawn?: SpawnFn;
  /** DI hook: allocate a local loopback port. Defaults to `port-allocator#allocatePort`. */
  allocatePort?: () => Promise<number>;
  /** DI hook: fetch impl for the readiness probe. Defaults to global `fetch`. */
  fetchFn?: FetchFn;
  /** DI hook: sleep between probe attempts. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** DI hook: monotonic time. Defaults to `Date.now`. */
  now?: () => number;
  /** Override the readiness deadline. Defaults to 10 s. */
  readyTimeoutMs?: number;
  /** Optional: called with each stdout/stderr line for diagnostic logging. */
  onLog?: (msg: string) => void;
}

/**
 * Open a `flyctl proxy` tunnel to a specific Fly machine.
 *
 * Allocates a local loopback port, spawns `flyctl proxy <local>:<remote>
 * <machineId>.vm.<app>.internal -a <app>`, then polls `/health` on the
 * local port until arkd answers 2xx. Rejects with a descriptive error if
 * the deadline elapses or the child exits before arkd becomes reachable.
 */
export async function openFlyTunnel(opts: OpenFlyTunnelOpts): Promise<FlyTunnel> {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const allocatePort = opts.allocatePort ?? defaultAllocatePort;
  const fetchFn: FetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const log = opts.onLog ?? (() => {});

  const localPort = await allocatePort();
  // flyctl proxy <local:remote> <remote_host> -a <app>
  //   remote_host pinned to a specific machine so we don't hit whichever
  //   machine Fly's DNS happens to round-robin to.
  const remoteHost = `${opts.machineId}.vm.${opts.appName}.internal`;
  const args = ["proxy", `${localPort}:${opts.remotePort}`, remoteHost, "-a", opts.appName];
  log(`fly-tunnel: spawning flyctl ${args.join(" ")}`);

  const child = spawn("flyctl", args, { stdio: ["ignore", "pipe", "pipe"], detached: false });
  const pid = child.pid ?? -1;

  // Track early exit so the readiness loop can bail out instead of timing out.
  let childExited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.on("exit", (code, signal) => {
    childExited = true;
    exitCode = code;
    exitSignal = signal;
  });
  // Forward process output to the caller's logger (useful for flyctl diagnostics).
  child.stdout?.on("data", (chunk: Buffer) => log(`fly-tunnel[stdout]: ${chunk.toString().trimEnd()}`));
  child.stderr?.on("data", (chunk: Buffer) => log(`fly-tunnel[stderr]: ${chunk.toString().trimEnd()}`));

  const probeUrl = `http://localhost:${localPort}/health`;
  const deadline = now() + readyTimeoutMs;
  let lastErr: unknown = null;
  while (now() < deadline) {
    if (childExited) {
      break;
    }
    try {
      const resp = await fetchFn(probeUrl, { signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS) });
      if (resp.ok) {
        log(`fly-tunnel: arkd reachable at http://localhost:${localPort} (pid=${pid})`);
        return buildHandle(child, pid, localPort);
      }
      lastErr = new Error(`HTTP ${resp.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(DEFAULT_READY_POLL_MS);
  }

  // Snapshot whether the child died on its own BEFORE we touch it -- the
  // kill below will flip `childExited` via the exit event even for the
  // timeout path, so we'd otherwise lose the ability to tell the two cases
  // apart.
  const exitedOnItsOwn = childExited;
  // Ready probe failed -- tear the child down best-effort before surfacing.
  await killChild(child, pid);
  if (exitedOnItsOwn) {
    const detail = exitSignal ? `signal=${exitSignal}` : exitCode !== null ? `code=${exitCode}` : "exited before ready";
    throw new Error(
      `flyctl proxy exited before arkd became reachable at http://localhost:${localPort} (${detail}). ` +
        `Check that flyctl is installed, FLY_API_TOKEN is valid, and machine ${opts.machineId} is running.`,
    );
  }
  const errDetail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown");
  throw new Error(
    `fly tunnel readiness timed out after ${readyTimeoutMs}ms on http://localhost:${localPort} ` +
      `(last error: ${errDetail}). Machine ${opts.machineId} may not be started, or flyctl may lack network access.`,
  );
}

function buildHandle(child: ChildProcess, pid: number, localPort: number): FlyTunnel {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await killChild(child, pid);
  };
  return { localPort, pid, close };
}

/**
 * SIGTERM the child, wait up to 2 s, then SIGKILL if still alive. Swallows
 * ESRCH so calling twice is safe. Callers don't need to handle errors.
 */
async function killChild(child: ChildProcess, pid: number): Promise<void> {
  if (pid <= 0) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  // First shot -- polite SIGTERM.
  try {
    child.kill("SIGTERM");
  } catch {
    // Already dead, fall through to the grace wait.
  }
  const exited = await waitForExit(child, CLOSE_GRACE_MS);
  if (exited) return;
  // Escalate. If the child is already zombie-d this throws ESRCH; swallow.
  try {
    child.kill("SIGKILL");
  } catch {
    // best-effort
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
