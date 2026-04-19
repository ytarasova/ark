/**
 * FlyMachinesCompute -- Phase 5 remote microVM backend, built on Fly.io
 * Machines. Each session gets a dedicated machine that runs arkd on :19300
 * reachable over Fly's 6PN private IPv6 network from the ark host.
 *
 * Lifecycle:
 *   provision: ensure the Fly app exists -> POST /machines with the bundled
 *              image that already runs arkd -> poll GET /machines/<id> until
 *              state=started -> return a handle whose `meta.fly` captures
 *              everything needed to start/stop/destroy/suspend later.
 *   start:     POST /machines/<id>/start. Auto-resumes suspended machines.
 *   stop:      POST /machines/<id>/stop.
 *   destroy:   DELETE /machines/<id>?force=true.
 *   snapshot:  POST /machines/<id>/suspend. Fly persists memory state to
 *              Fly's storage layer; a Snapshot here is a handle back to
 *              the same machine id -- restore calls /start to resume.
 *   restore:   POST /machines/<id>/start with the handle reconstructed from
 *              snapshot metadata.
 *
 * Runtime composition: FlyMachinesCompute pairs with any Runtime. By
 * default `getArkdUrl` returns http://[<privateIp>]:19300 -- the conductor
 * host must have a WireGuard / `fly proxy` route into 6PN. In a pure
 * managed deploy the conductor runs on Fly itself and reaches 6PN without
 * extra setup.
 *
 * Non-Fly conductors (local dev, a laptop, a bare EC2 box) can enable the
 * optional `flyctl proxy` tunnel via `new FlyMachinesCompute({ useTunnel:
 * true })` or the `ARK_FLY_TUNNEL=1` env var. When active, provision
 * spawns a `flyctl proxy` child that forwards a local loopback port to
 * 6PN, and `getArkdUrl` returns `http://localhost:<port>`. See `./tunnel.ts`.
 *
 * Every HTTP call is routed through `FlyMachinesComputeDeps.fetchFn` so
 * unit tests can stub responses without touching the real Fly API. The
 * `setFlyHooksForTesting` hook mirrors the DI pattern used by
 * FirecrackerCompute (`__setFirecrackerHooksForTesting`).
 */

import type { AppContext } from "../../../core/app.js";
import { logDebug, logInfo } from "../../../core/observability/structured-log.js";
import type { Compute, ComputeCapabilities, ComputeHandle, ComputeKind, ProvisionOpts, Snapshot } from "../types.js";
import {
  createApp,
  createMachine,
  destroyMachine,
  getMachine,
  makeFlyClient,
  startMachine,
  stopMachine,
  suspendMachine,
  type FlyFetchFn,
  type FlyMachineConfig,
} from "./api.js";
import { openFlyTunnel, type FlyTunnel, type OpenFlyTunnelOpts, type SpawnFn } from "./tunnel.js";

/** Arkd port inside the Fly machine. Always 19300 to match the arkd-sidecar contract. */
const ARKD_PORT = 19300;
/** Default image used when ProvisionOpts.config.image is absent. Must bundle arkd. */
const DEFAULT_IMAGE = "registry.fly.io/ark-arkd:latest";
/** Default region when none is supplied. Chosen for lowest cross-ocean latency from us-east. */
const DEFAULT_REGION = "ord";
/** Default machine size. "shared-cpu-1x" is the cheapest Fly size with a 6PN IP. */
const DEFAULT_SIZE = "shared-cpu-1x";
/** How long we wait for a freshly created machine to reach state=started. */
const PROVISION_READY_TIMEOUT_MS = 120_000;
/** Poll interval while waiting for state=started. */
const PROVISION_POLL_INTERVAL_MS = 1000;

// ── DI surface ─────────────────────────────────────────────────────────────

/**
 * Dependency surface tests can override. Production wiring defaults to
 * `fetch` + `setTimeout`; tests pass deterministic stubs.
 */
export interface FlyMachinesComputeDeps {
  /** Fetch used by every Fly API call. Defaults to global `fetch`. */
  fetchFn: FlyFetchFn;
  /** Sleep between polls while waiting for state=started. Overridable in tests. */
  sleep: (ms: number) => Promise<void>;
  /** Current time for snapshot createdAt. Overridable for deterministic tests. */
  now: () => number;
  /**
   * Spawn impl used when `useTunnel` is active. Defaults to node's
   * `child_process#spawn`. Tests pass a stub that returns a fake
   * `ChildProcess` without touching the real flyctl binary.
   */
  spawn: SpawnFn;
  /**
   * Allocate a local loopback port. Defaults to `port-allocator#allocatePort`.
   * Tests can stub to return a deterministic port.
   */
  allocatePort: () => Promise<number>;
  /**
   * Optional override for opening a tunnel. Defaults to the production
   * `openFlyTunnel` helper. Tests prefer stubbing `spawn` + `allocatePort`
   * + `fetchFn` because that covers the tunnel module's behavior too, but
   * end-to-end replacement is available for cases where that is easier.
   */
  openTunnel: (opts: OpenFlyTunnelOpts) => Promise<FlyTunnel>;
}

const productionDeps: FlyMachinesComputeDeps = {
  fetchFn: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  // Lazy default -- node's child_process is only pulled in when a caller
  // actually enables the tunnel. Keeps the import graph lean for Fly-native
  // deployments that don't need it.
  spawn: ((command, args, options) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require("node:child_process");
    return spawn(command, args, options);
  }) as SpawnFn,
  allocatePort: async () => {
    const { allocatePort } = await import("../../../core/config/port-allocator.js");
    return allocatePort();
  },
  openTunnel: (opts) => openFlyTunnel(opts),
};

let testingHooks: Partial<FlyMachinesComputeDeps> | null = null;

/**
 * Test-only: install stub deps for every FlyMachinesCompute constructed
 * after this call. Pass `null` to restore production deps. Mirrors the
 * `__setFirecrackerHooksForTesting` pattern used elsewhere in the compute
 * layer.
 */
export function setFlyHooksForTesting(hooks: Partial<FlyMachinesComputeDeps> | null): void {
  testingHooks = hooks;
}

// ── Provision config + handle shape ────────────────────────────────────────

/** Read from `ProvisionOpts.config`. Every field is optional. */
export interface FlyMachinesProvisionConfig {
  /** Fly org slug for the app. Defaults to "personal". */
  orgSlug?: string;
  /** Explicit Fly app name; defaults to `ark-<sanitized-tag-or-random>`. */
  appName?: string;
  /** Region code, e.g. "ord" / "lax". */
  region?: string;
  /** Docker image (must bundle arkd). */
  image?: string;
  /** Env vars injected into the machine. */
  env?: Record<string, string>;
  /** Size label forwarded to Fly (e.g. "shared-cpu-1x", "performance-1x"). */
  size?: string;
  /** Optional mounts to attach to the machine config. */
  mounts?: Array<{ name?: string; path: string; volume?: string; size_gb?: number }>;
}

/** Stored on `handle.meta.fly` after a successful provision. */
export interface FlyMeta {
  appName: string;
  machineId: string;
  region: string;
  privateIp: string;
  arkdPort: number;
  /**
   * Arkd URL the conductor should hit. When a tunnel is active this is the
   * `http://localhost:<localPort>` loopback; otherwise it's the 6PN URL.
   * `getArkdUrl(handle)` always returns this.
   */
  arkdUrl: string;
  image: string;
  size: string;
  /**
   * Original 6PN URL kept for diagnostics. Even when a tunnel is active the
   * 6PN URL stays recorded so debug logs / future pool logic can see it.
   */
  arkdRemoteUrl?: string;
  /** Host-side loopback port when a `flyctl proxy` tunnel is active. */
  arkdLocalPort?: number;
  /** PID of the `flyctl proxy` subprocess, if one was spawned. */
  tunnelPid?: number;
}

/** Construction options for `FlyMachinesCompute`. */
export interface FlyMachinesComputeOptions {
  /**
   * When true, `provision` spawns a `flyctl proxy` tunnel so the machine's
   * arkd is reachable from a non-Fly conductor via `http://localhost:<port>`.
   * Default: `false`. Also enabled when `ARK_FLY_TUNNEL=1` is set in the env.
   *
   * Leave OFF when the conductor itself runs on Fly -- the 6PN IPv6 URL
   * works natively there and a tunnel would just add overhead.
   */
  useTunnel?: boolean;
}

// ── Compute ────────────────────────────────────────────────────────────────

export class FlyMachinesCompute implements Compute {
  readonly kind: ComputeKind = "fly-machines";
  readonly capabilities: ComputeCapabilities = {
    snapshot: true,
    // Fly supports pool semantics: suspend/resume is the rewind primitive a
    // FlyPool would use, and the 6PN network lets warm machines sit idle
    // cheaply. The concrete FlyPool impl is a follow-up -- until one is
    // registered against this compute kind, ComputeTarget.provision falls
    // through to direct provisioning, so flipping this flag is safe.
    pool: true,
    networkIsolation: true,
    provisionLatency: "seconds",
  };

  private app: AppContext | null = null;
  private deps: FlyMachinesComputeDeps;
  private readonly useTunnel: boolean;

  constructor(optsOrDeps?: FlyMachinesComputeOptions | Partial<FlyMachinesComputeDeps>) {
    // Back-compat: historically this constructor took `Partial<Deps>` directly.
    // Still accept that shape -- detect FlyMachinesComputeOptions by the
    // presence of the `useTunnel` key (no Deps field collides with it).
    const opts: FlyMachinesComputeOptions = {};
    const deps: Partial<FlyMachinesComputeDeps> = {};
    if (optsOrDeps) {
      for (const [key, value] of Object.entries(optsOrDeps)) {
        if (key === "useTunnel") opts.useTunnel = value as boolean;
        else (deps as Record<string, unknown>)[key] = value;
      }
    }
    this.useTunnel = opts.useTunnel ?? process.env.ARK_FLY_TUNNEL === "1";
    // Merge order: production -> global testing hooks -> per-instance overrides.
    // Per-instance wins so individual tests can still pin a specific fetchFn
    // while leaving global deps alone.
    this.deps = { ...productionDeps, ...(testingHooks ?? {}), ...deps };
  }

  setApp(app: AppContext): void {
    this.app = app;
  }

  /** Test-only: swap deps post-construction. */
  setDepsForTesting(partial: Partial<FlyMachinesComputeDeps>): void {
    this.deps = { ...this.deps, ...partial };
  }

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    const token = requireFlyToken();
    const cfg = (opts.config ?? {}) as FlyMachinesProvisionConfig;
    const name = (opts.tags?.name as string | undefined) ?? `fly-${randomSuffix()}`;
    const appName = cfg.appName ?? defaultAppName(opts.tags, name);
    const region = cfg.region ?? DEFAULT_REGION;
    const image = cfg.image ?? DEFAULT_IMAGE;
    const size = cfg.size ?? DEFAULT_SIZE;

    const client = makeFlyClient(token, this.deps.fetchFn);

    // 1. Ensure the app exists. 422 = already exists (handled inside createApp).
    const appResult = await createApp(client, appName, cfg.orgSlug ?? "personal");
    opts.onLog?.(`fly: app ${appName} ${appResult.created ? "created" : "already existed"}`);

    // 2. Build the machine config + create the machine. Fly starts the machine
    //    as part of POST /machines; we still poll until state=started before
    //    returning so the handle is guaranteed to reach arkd.
    const machineConfig: FlyMachineConfig = {
      image,
      env: cfg.env,
      mounts: cfg.mounts,
      services: [
        {
          internal_port: ARKD_PORT,
          protocol: "tcp",
          // Empty ports array -- we only expose arkd over 6PN to the conductor,
          // never to the public internet. Fly still routes internal traffic to
          // the private IP even when no public edges are declared.
          ports: [],
        },
      ],
      size,
    };
    const created = await createMachine(client, appName, { name, region, config: machineConfig });
    opts.onLog?.(`fly: machine ${created.id} created in ${region}`);

    // 3. Poll until state=started or timeout. We also need the private_ip
    //    which Fly only populates once the machine finishes allocation -- the
    //    initial createMachine response sometimes lacks it.
    const ready = await this.waitUntilStarted(client, appName, created.id);

    const privateIp = ready.private_ip ?? created.private_ip ?? "";
    if (!privateIp) {
      throw new Error(`Fly machine ${created.id} reached state=${ready.state} but has no private_ip`);
    }

    const remoteUrl = buildArkdUrl(privateIp);
    const meta: FlyMeta = {
      appName,
      machineId: ready.id,
      region: ready.region ?? region,
      privateIp,
      arkdPort: ARKD_PORT,
      arkdUrl: remoteUrl,
      image,
      size,
    };

    // 4. Optional `flyctl proxy` tunnel for conductors running off-Fly.
    //    Rolled into a best-effort destroy of the machine on failure so we
    //    don't leak a half-provisioned resource back to the caller.
    if (this.useTunnel) {
      opts.onLog?.(`fly: opening flyctl proxy tunnel to machine ${ready.id}...`);
      try {
        const tunnel = await this.deps.openTunnel({
          appName,
          machineId: ready.id,
          remotePort: ARKD_PORT,
          spawn: this.deps.spawn,
          allocatePort: this.deps.allocatePort,
          fetchFn: (input, init) => this.deps.fetchFn(input, init),
          sleep: this.deps.sleep,
          now: this.deps.now,
          onLog: opts.onLog,
        });
        meta.arkdRemoteUrl = remoteUrl;
        meta.arkdLocalPort = tunnel.localPort;
        meta.tunnelPid = tunnel.pid;
        meta.arkdUrl = `http://localhost:${tunnel.localPort}`;
        opts.onLog?.(`fly: tunnel ready at ${meta.arkdUrl} (pid=${tunnel.pid})`);
      } catch (err) {
        opts.onLog?.(`fly: tunnel failed for machine ${ready.id}; destroying machine`);
        // Best-effort rollback -- swallow teardown errors so the original
        // cause surfaces to the caller.
        try {
          await destroyMachine(client, appName, ready.id);
        } catch {
          /* intentionally ignored -- original error wins */
        }
        throw err;
      }
    }

    opts.onLog?.(`fly: machine ${ready.id} ready at ${meta.arkdUrl}`);

    return { kind: this.kind, name, meta: { fly: meta } };
  }

  async start(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    const client = makeFlyClient(requireFlyToken(), this.deps.fetchFn);
    await startMachine(client, meta.appName, meta.machineId);
  }

  async stop(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    // Tear the tunnel down before stopping the machine -- stopping the
    // machine drops the WireGuard endpoint anyway, but killing explicitly
    // frees the local port and the flyctl subprocess.
    await this.killTunnelIfAny(meta);
    const client = makeFlyClient(requireFlyToken(), this.deps.fetchFn);
    await stopMachine(client, meta.appName, meta.machineId);
  }

  async destroy(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    await this.killTunnelIfAny(meta);
    const client = makeFlyClient(requireFlyToken(), this.deps.fetchFn);
    await destroyMachine(client, meta.appName, meta.machineId);
  }

  getArkdUrl(h: ComputeHandle): string {
    const meta = readMeta(h);
    // Prefer the localhost URL when a tunnel is active -- that's the only
    // thing a non-Fly conductor can actually reach.
    if (meta.arkdLocalPort) return `http://localhost:${meta.arkdLocalPort}`;
    return meta.arkdUrl;
  }

  /**
   * Suspend the Fly machine. Fly persists memory + vCPU state to its
   * storage layer; the machine id is our snapshot handle. Restore later
   * via `start` (Fly auto-resumes suspended machines on start).
   */
  async snapshot(h: ComputeHandle): Promise<Snapshot> {
    const meta = readMeta(h);
    const client = makeFlyClient(requireFlyToken(), this.deps.fetchFn);
    await suspendMachine(client, meta.appName, meta.machineId);

    const createdAt = new Date(this.deps.now()).toISOString();
    return {
      id: meta.machineId,
      computeKind: this.kind,
      createdAt,
      sizeBytes: 0, // Fly doesn't expose suspended-state size.
      metadata: {
        machineId: meta.machineId,
        appName: meta.appName,
        region: meta.region,
        privateIp: meta.privateIp,
        image: meta.image,
        size: meta.size,
      },
    };
  }

  /**
   * Restore a suspended machine by starting it. Fly picks up where suspend
   * left off; the private_ip survives the suspend/resume cycle so we can
   * reconstruct the handle directly from snapshot metadata without polling.
   */
  async restore(s: Snapshot): Promise<ComputeHandle> {
    if (s.computeKind !== this.kind) {
      throw new Error(`Snapshot is for ${s.computeKind}, cannot restore into ${this.kind}`);
    }
    const md = s.metadata as Partial<FlyMeta> & { machineId?: string; appName?: string };
    const machineId = md.machineId;
    const appName = md.appName;
    const privateIp = md.privateIp ?? "";
    const region = md.region ?? DEFAULT_REGION;
    const image = md.image ?? DEFAULT_IMAGE;
    const size = md.size ?? DEFAULT_SIZE;
    if (!machineId || !appName || !privateIp) {
      throw new Error("Fly snapshot metadata is missing required fields (machineId, appName, privateIp)");
    }

    const client = makeFlyClient(requireFlyToken(), this.deps.fetchFn);
    await startMachine(client, appName, machineId);

    const meta: FlyMeta = {
      appName,
      machineId,
      region,
      privateIp,
      arkdPort: ARKD_PORT,
      arkdUrl: buildArkdUrl(privateIp),
      image,
      size,
    };
    return { kind: this.kind, name: machineId, meta: { fly: meta } };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Best-effort SIGTERM+SIGKILL on a lingering `flyctl proxy` PID recorded
   * on the handle. Used by `stop` / `destroy`. Swallows ESRCH so calling
   * twice (e.g. stop then destroy) is safe. Always clears the meta fields
   * so a subsequent `start` knows it needs to respawn.
   */
  private async killTunnelIfAny(meta: FlyMeta): Promise<void> {
    const pid = meta.tunnelPid;
    if (!pid || pid <= 0) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    // Give the child 2s to exit, then escalate.
    await this.deps.sleep(2_000);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    meta.tunnelPid = undefined;
    meta.arkdLocalPort = undefined;
    // Restore the 6PN URL so a future in-Fly caller still has something
    // to look at. getArkdUrl prefers arkdLocalPort when set, so clearing
    // it means the compute falls back to whatever's in arkdUrl.
    if (meta.arkdRemoteUrl) {
      meta.arkdUrl = meta.arkdRemoteUrl;
      meta.arkdRemoteUrl = undefined;
    }
  }

  private async waitUntilStarted(
    client: ReturnType<typeof makeFlyClient>,
    appName: string,
    machineId: string,
  ): Promise<{ id: string; state: string; region?: string; private_ip?: string }> {
    const deadline = this.deps.now() + PROVISION_READY_TIMEOUT_MS;
    let last: { id: string; state: string; region?: string; private_ip?: string } | null = null;
    while (this.deps.now() < deadline) {
      last = await getMachine(client, appName, machineId);
      if (last.state === "started") return last;
      if (last.state === "failed" || last.state === "destroyed") {
        throw new Error(`Fly machine ${machineId} entered terminal state=${last.state} during provision`);
      }
      await this.deps.sleep(PROVISION_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Fly machine ${machineId} did not reach state=started within ${PROVISION_READY_TIMEOUT_MS}ms ` +
        `(last state=${last?.state ?? "unknown"})`,
    );
  }
}

// ── Registration ───────────────────────────────────────────────────────────

/**
 * Register FlyMachinesCompute iff `FLY_API_TOKEN` is set. Mirrors the
 * `registerFirecrackerIfAvailable` gate so hosts without Fly credentials
 * silently skip registration instead of failing at boot.
 */
export function registerFlyIfAvailable(app: AppContext): FlyMachinesCompute | null {
  if (!process.env.FLY_API_TOKEN) {
    logDebug("compute", "fly compute registration skipped: FLY_API_TOKEN not set");
    return null;
  }
  const compute = new FlyMachinesCompute();
  compute.setApp(app);
  app.registerCompute(compute);
  logInfo("compute", "fly compute registered");
  return compute;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function requireFlyToken(): string {
  const token = process.env.FLY_API_TOKEN;
  if (!token) {
    throw new Error(
      "FlyMachinesCompute requires FLY_API_TOKEN in the environment. " +
        "Obtain a token via `fly tokens create deploy` and export it before boot.",
    );
  }
  return token;
}

function readMeta(h: ComputeHandle): FlyMeta {
  const slot = (h.meta as { fly?: FlyMeta }).fly;
  if (!slot) {
    throw new Error(`Fly handle.meta.fly missing; got keys: [${Object.keys(h.meta).join(", ")}]`);
  }
  return slot;
}

function buildArkdUrl(privateIp: string): string {
  // Fly 6PN addresses are IPv6 -- URL host must be bracketed.
  return `http://[${privateIp}]:${ARKD_PORT}`;
}

function defaultAppName(tags: Record<string, string> | undefined, fallback: string): string {
  const tenant = tags?.tenant;
  const session = tags?.session;
  if (tenant && session) return sanitizeAppName(`ark-${tenant}-${session}`);
  if (session) return sanitizeAppName(`ark-${session}`);
  return sanitizeAppName(`ark-${fallback}`);
}

function sanitizeAppName(raw: string): string {
  // Fly app names: 3-30 chars, lowercase alnum + hyphen.
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
