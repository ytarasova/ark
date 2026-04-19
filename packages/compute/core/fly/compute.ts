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
 * Runtime composition: FlyMachinesCompute pairs with any Runtime. The
 * getArkdUrl returns http://[<privateIp>]:19300 -- the conductor host must
 * have a WireGuard / `fly proxy` route into 6PN. In a pure managed deploy
 * the conductor runs on Fly itself and reaches 6PN without extra setup.
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
}

const productionDeps: FlyMachinesComputeDeps = {
  fetchFn: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
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
  arkdUrl: string;
  image: string;
  size: string;
}

// ── Compute ────────────────────────────────────────────────────────────────

export class FlyMachinesCompute implements Compute {
  readonly kind: ComputeKind = "fly-machines";
  readonly capabilities: ComputeCapabilities = {
    snapshot: true,
    pool: false,
    networkIsolation: true,
    provisionLatency: "seconds",
  };

  private app: AppContext | null = null;
  private deps: FlyMachinesComputeDeps;

  constructor(deps?: Partial<FlyMachinesComputeDeps>) {
    // Merge order: production -> global testing hooks -> per-instance overrides.
    // Per-instance wins so individual tests can still pin a specific fetchFn
    // while leaving global deps alone.
    this.deps = { ...productionDeps, ...(testingHooks ?? {}), ...(deps ?? {}) };
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

    const arkdUrl = buildArkdUrl(privateIp);
    const meta: FlyMeta = {
      appName,
      machineId: ready.id,
      region: ready.region ?? region,
      privateIp,
      arkdPort: ARKD_PORT,
      arkdUrl,
      image,
      size,
    };

    opts.onLog?.(`fly: machine ${ready.id} ready at ${arkdUrl}`);

    return { kind: this.kind, name, meta: { fly: meta } };
  }

  async start(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    const client = makeFlyClient(requireFlyToken(), this.deps.fetchFn);
    await startMachine(client, meta.appName, meta.machineId);
  }

  async stop(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    const client = makeFlyClient(requireFlyToken(), this.deps.fetchFn);
    await stopMachine(client, meta.appName, meta.machineId);
  }

  async destroy(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    const client = makeFlyClient(requireFlyToken(), this.deps.fetchFn);
    await destroyMachine(client, meta.appName, meta.machineId);
  }

  getArkdUrl(h: ComputeHandle): string {
    return readMeta(h).arkdUrl;
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
