/**
 * EC2Compute -- Compute impl that lives on an AWS EC2 instance.
 *
 * Transport: pure AWS SSM. The conductor reaches arkd through a port
 * forwarded by `aws ssm start-session --document AWS-StartPortForwardingSession`,
 * and runs remote shell commands via `ssm.SendCommand`. There is no SSH
 * layer at all. The instance needs no public IP, no security-group ingress,
 * and no SSH keypair -- the SSM agent + IAM role
 * (`AmazonSSMManagedInstanceCore`) is the entire transport contract.
 *
 * Lifecycle overview:
 *
 *   provision: provisionStack (RunInstances + IAM SSM role + SG without
 *              ingress) -> wait for SSM agent online -> wait for cloud-init
 *              "ready" marker via ssmExec -> open a port-forward from a
 *              local ephemeral port to arkd's internal :19300 -> wait for
 *              arkd /health through the forward -> return a handle whose
 *              `meta.ec2` captures everything needed to resume, tear down,
 *              and talk to arkd.
 *
 *   getArkdUrl: always returns http://localhost:<arkdLocalPort>. The
 *               conductor talks to arkd via the SSM port-forward; the
 *               instance ID is the canonical address, no IP needed.
 *
 *   start / stop: map to EC2 StartInstances / StopInstances. `start`
 *                 waits until the instance is running, then re-establishes
 *                 the port-forward (the local port stays stable across
 *                 restarts).
 *
 *   destroy: TerminateInstances (via `destroyStack`), kill the port
 *            forward, drop the security group the stack created.
 *
 * Snapshot / restore: deferred. Both throw NotSupportedError with
 * `capabilities.snapshot = true` still reported so dispatch can hint
 * at the eventual shape -- tests assert both.
 *
 * Isolation composition: EC2Compute pairs with any Isolation (DirectIsolation,
 * DockerIsolation, DevcontainerIsolation, DockerComposeIsolation). The
 * isolation's container / devcontainer / compose logic is completely
 * unchanged -- the Isolation just calls `compute.getArkdUrl(h)` and talks
 * to arkd through the port-forward exactly like LocalCompute. That works
 * because arkd inside the EC2 instance owns every container it launches via
 * its own docker / devcontainer / compose machinery, and those all listen
 * back on the instance's loopback -- the forward's :19300 -> :19300 picks
 * them up transparently.
 *
 * All AWS / SSM side-effects go through the injectable `EC2ComputeHelpers`
 * surface. Production wiring passes the real functions from `../providers/ec2/*`;
 * tests swap in stubs to avoid hitting AWS. We intentionally import the
 * helpers lazily so the AWS SDK is not pulled into cold-start paths that
 * never provision an EC2 compute.
 */

import type { AppContext } from "../../app.js";
import type { Session } from "../../../types/session.js";
import { ArkdClient } from "../../../arkd/client/index.js";
import { attachComputeMethods, type ArkdClientFactory } from "../handle-helpers.js";
import type {
  Compute,
  ComputeCapabilities,
  ComputeHandle,
  ComputeKind,
  EnsureReachableOpts,
  FlushPlacementOpts,
  PrepareWorkspaceOpts,
  ProvisionOpts,
  Snapshot,
} from "../types.js";
import { NotSupportedError } from "../types.js";
import { REMOTE_HOME } from "./constants.js";
import { cloneWorkspaceViaArkd } from "../workspace-clone.js";
import { logDebug, logInfo } from "../../observability/structured-log.js";
import { provisionStep } from "../../services/provisioning-steps.js";
import { startArkdEventsConsumer } from "../../conductor/server/arkd-events-consumer.js";
import { EC2PlacementCtx } from "./placement-ctx.js";
import type { PlacementCtx } from "../../secrets/placement-types.js";

// ── Config read from ProvisionOpts / AppContext ─────────────────────────────

/**
 * EC2-specific provisioning config accepted on `ProvisionOpts.config`.
 * Every field is optional; defaults map to us-east-1 / size=m / arch=x64.
 */
export interface EC2ProvisionConfig {
  region?: string;
  awsProfile?: string;
  subnetId?: string;
  securityGroupId?: string;
  /** Minutes of idleness before cloud-init triggers shutdown. */
  idleMinutes?: number;
  /** Isolation flavour label forwarded into cloud-init. */
  isolation?: string;
  /** Conductor URL injected into cloud-init so arkd can reverse-reach. */
  conductorUrl?: string;
  /** Pre-baked user-data overriding the default cloud-init bundle. */
  userData?: string;
}

/** Shape stashed on `handle.meta.ec2` after a successful provision. */
export interface EC2HandleMeta {
  /** AWS instance id returned by RunInstances. Canonical address for SSM. */
  instanceId: string;
  /** Current public IPv4 (null when private subnet -- typical with SSM). */
  publicIp: string | null;
  /** Private IPv4 on the VPC (informational; not required for transport). */
  privateIp: string | null;
  /** Local ephemeral host port the SSM port-forward listens on. */
  arkdLocalPort: number;
  /**
   * PID of the backgrounded `aws ssm start-session
   * --document AWS-StartPortForwardingSession` process. Renamed from the
   * legacy `sshPid` -- we no longer spawn ssh, just the AWS CLI.
   */
  portForwardPid: number | null;
  /** AWS region the stack lives in. Required for SSM session establishment. */
  region: string;
  /** Optional AWS profile for credentials. */
  awsProfile?: string;
  /** Stack name returned by `provisionStack` (used by `destroyStack`). */
  stackName: string;
  /** Security group id if we created a fresh one; undefined if we reused. */
  sgId?: string;
  /** Instance size label (e.g. "m"). */
  size: string;
  /** Architecture label ("x64" / "arm"). */
  arch: string;
}

// ── Injectable helper surface (DI for tests) ────────────────────────────────

/**
 * The set of EC2 / SSM side-effects EC2Compute depends on. Tests swap all of
 * these via `setHelpersForTesting` so no real AWS call ever fires.
 *
 * Kept deliberately minimal: each helper mirrors exactly one external
 * operation, which makes assertions trivial and keeps the production wiring
 * a straight passthrough.
 */
export interface EC2ComputeHelpers {
  /**
   * One-shot remote command via SSM SendCommand. Returns exitCode 0 on
   * success; never throws. The host arg is an EC2 instance_id; SSM provides
   * the underlying transport.
   */
  ssmExec: (opts: {
    instanceId: string;
    command: string;
    timeoutMs?: number;
    region?: string;
    awsProfile?: string;
  }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** SSM connectivity check via DescribeInstanceInformation. */
  ssmCheckInstance: (opts: { instanceId: string; region?: string; awsProfile?: string }) => Promise<boolean>;
  /**
   * SSM connectivity poll: waits up to 150s for the SSM agent to come online.
   * Production wraps the real `ssmWaitForReady`; tests stub it to return
   * instantly so the connectivity-check step doesn't block the suite.
   */
  ssmWaitForReady: (opts: { instanceId: string; region?: string; awsProfile?: string }) => Promise<boolean>;
  /** Build the cloud-init user-data bundle. */
  buildUserData: (opts: {
    idleMinutes?: number;
    isolation?: string;
    conductorUrl?: string;
  }) => Promise<string> | string;
  /** RunInstances + wait for running state. */
  provisionStack: (
    hostName: string,
    opts: Record<string, unknown>,
  ) => Promise<{
    ip: string | null;
    instance_id: string;
    stack_name: string;
    sg_id?: string;
  }>;
  /** TerminateInstances + clean up SG. */
  destroyStack: (hostName: string, opts?: Record<string, unknown>) => Promise<void>;
  /** StartInstances, returns once the instance is running with a public IP. */
  startInstance: (opts: {
    instanceId: string;
    region: string;
    awsProfile?: string;
  }) => Promise<{ publicIp: string | null; privateIp: string | null }>;
  /** StopInstances (no wait). */
  stopInstance: (opts: { instanceId: string; region: string; awsProfile?: string }) => Promise<void>;
  /** DescribeInstances -> IPs. Used by start() polling and tunnel restoration. */
  describeInstance: (opts: {
    instanceId: string;
    region: string;
    awsProfile?: string;
  }) => Promise<{ publicIp: string | null; privateIp: string | null }>;
  /**
   * Spawn a background `aws ssm start-session
   * --document AWS-StartPortForwardingSession` process and return its PID.
   * The returned PID is stored on `handle.meta.ec2.portForwardPid`.
   *
   * Async because the implementation polls the local port until the
   * session-manager-plugin has bound a listener (the AWS CLI returns
   * before the plugin hands off the listening socket; without this wait,
   * `arkd-probe` racing the port-forward sees ECONNREFUSED for the full
   * arkd-probe budget and dispatch fails). 5-12s on cold paths.
   */
  startPortForward: (opts: {
    instanceId: string;
    region: string;
    awsProfile?: string;
    localPort: number;
    remotePort: number;
  }) => Promise<{ pid: number }> | { pid: number };
  /** Kill a port-forward PID (SIGTERM, then SIGKILL after 1s). Swallows ESRCH. */
  killPortForward: (pid: number) => Promise<void> | void;
  /**
   * Allocate a free ephemeral host port. Wired to
   * `core/config/port-allocator.ts#allocatePort` in production.
   */
  allocatePort: () => Promise<number>;
  /** GET /health with a short timeout -- used to wait for arkd. */
  fetchHealth: (url: string, timeoutMs: number) => Promise<boolean>;
  /** Poll a predicate with `maxAttempts` * `delayMs`. Returns true on success. */
  poll: (check: () => Promise<boolean> | boolean, opts: { maxAttempts: number; delayMs: number }) => Promise<boolean>;
}

// ── Defaults (production wiring, lazy-imported) ─────────────────────────────

/** Internal arkd listens on this port inside the EC2 instance. */
export const ARKD_REMOTE_PORT = 19300;

async function defaultFetchHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function defaultStartInstance(opts: {
  instanceId: string;
  region: string;
  awsProfile?: string;
}): Promise<{ publicIp: string | null; privateIp: string | null }> {
  const { EC2Client, StartInstancesCommand, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
  const { awsCredentialsForProfile } = await import("./aws-creds.js");
  const { poll } = await import("../util.js");
  const client = new EC2Client({
    region: opts.region,
    credentials: awsCredentialsForProfile({ profile: opts.awsProfile }),
  });
  await client.send(new StartInstancesCommand({ InstanceIds: [opts.instanceId] }));
  let publicIp: string | null = null;
  let privateIp: string | null = null;
  await poll(
    async () => {
      const desc = await client.send(new DescribeInstancesCommand({ InstanceIds: [opts.instanceId] }));
      const inst = desc.Reservations?.[0]?.Instances?.[0];
      publicIp = inst?.PublicIpAddress ?? null;
      privateIp = inst?.PrivateIpAddress ?? null;
      return publicIp !== null || privateIp !== null;
    },
    { maxAttempts: 30, delayMs: 5000 },
  );
  return { publicIp, privateIp };
}

async function defaultStopInstance(opts: { instanceId: string; region: string; awsProfile?: string }): Promise<void> {
  const { EC2Client, StopInstancesCommand } = await import("@aws-sdk/client-ec2");
  const { awsCredentialsForProfile } = await import("./aws-creds.js");
  const client = new EC2Client({
    region: opts.region,
    credentials: awsCredentialsForProfile({ profile: opts.awsProfile }),
  });
  await client.send(new StopInstancesCommand({ InstanceIds: [opts.instanceId] }));
}

async function defaultDescribeInstance(opts: {
  instanceId: string;
  region: string;
  awsProfile?: string;
}): Promise<{ publicIp: string | null; privateIp: string | null }> {
  const { EC2Client, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
  const { awsCredentialsForProfile } = await import("./aws-creds.js");
  const client = new EC2Client({
    region: opts.region,
    credentials: awsCredentialsForProfile({ profile: opts.awsProfile }),
  });
  const desc = await client.send(new DescribeInstancesCommand({ InstanceIds: [opts.instanceId] }));
  const inst = desc.Reservations?.[0]?.Instances?.[0];
  return {
    publicIp: inst?.PublicIpAddress ?? null,
    privateIp: inst?.PrivateIpAddress ?? null,
  };
}

const DEFAULT_HELPERS: EC2ComputeHelpers = {
  ssmExec: (async (opts) => {
    const { ssmExec } = await import("./ssm.js");
    return ssmExec(opts);
  }) as EC2ComputeHelpers["ssmExec"],
  ssmCheckInstance: (async (opts) => {
    const { ssmCheckInstance } = await import("./ssm.js");
    return ssmCheckInstance(opts);
  }) as EC2ComputeHelpers["ssmCheckInstance"],
  ssmWaitForReady: (async (opts) => {
    const { ssmWaitForReady } = await import("./ssm.js");
    return ssmWaitForReady(opts);
  }) as EC2ComputeHelpers["ssmWaitForReady"],
  buildUserData: (async (opts) => {
    const { buildUserData } = await import("./cloud-init.js");
    return buildUserData(opts);
  }) as EC2ComputeHelpers["buildUserData"],
  provisionStack: (async (hostName, opts) => {
    const { provisionStack } = await import("./provision.js");
    return provisionStack(hostName, opts as any);
  }) as EC2ComputeHelpers["provisionStack"],
  destroyStack: (async (hostName, opts) => {
    const { destroyStack } = await import("./provision.js");
    return destroyStack(hostName, opts as any);
  }) as EC2ComputeHelpers["destroyStack"],
  startInstance: defaultStartInstance,
  stopInstance: defaultStopInstance,
  describeInstance: defaultDescribeInstance,
  startPortForward: (async (opts) => {
    const { ssmStartPortForward } = await import("./ssm.js");
    return ssmStartPortForward(opts);
  }) as EC2ComputeHelpers["startPortForward"],
  killPortForward: (async (pid) => {
    const { ssmKillPortForward } = await import("./ssm.js");
    ssmKillPortForward(pid);
  }) as EC2ComputeHelpers["killPortForward"],
  allocatePort: (async () => {
    const { allocatePort } = await import("../../config/port-allocator.js");
    return allocatePort();
  }) as EC2ComputeHelpers["allocatePort"],
  fetchHealth: defaultFetchHealth,
  poll: (async (check, opts) => {
    const { poll } = await import("../util.js");
    return poll(check, opts);
  }) as EC2ComputeHelpers["poll"],
};

// ── The Compute impl ────────────────────────────────────────────────────────

export class EC2Compute implements Compute {
  readonly kind: ComputeKind = "ec2";
  readonly capabilities: ComputeCapabilities = {
    snapshot: true,
    pool: true,
    networkIsolation: true,
    provisionLatency: "minutes",
    singleton: false,
    canDelete: true,
    canReboot: true,
    supportsWorktree: false,
    supportsSecretMount: false,
    needsAuth: true,
    initialStatus: "stopped",
    isolationModes: [{ value: "remote", label: "Remote worktree" }],
  };

  private helpers: EC2ComputeHelpers = DEFAULT_HELPERS;
  private clientFactory: ArkdClientFactory = (url) => new ArkdClient(url);

  constructor(private readonly app: AppContext) {}

  /** Test-only: swap in a stub `ArkdClient` factory for `getMetrics`. */
  setClientFactoryForTesting(factory: ArkdClientFactory): void {
    this.clientFactory = factory;
  }

  /**
   * Test-only: swap in stubs for every EC2 / SSM side-effect. Partial
   * overrides merge over DEFAULT_HELPERS, so a test only has to stub what
   * it cares about.
   */
  setHelpersForTesting(helpers: Partial<EC2ComputeHelpers>): void {
    this.helpers = { ...DEFAULT_HELPERS, ...helpers };
  }

  // ── provision ────────────────────────────────────────────────────────────
  //
  // Ordering invariant (see `setupTransport` for the long form): provision
  // calls setupTransport with `{ log }` only -- no `app`/`sessionId`. That
  // skips the events-consumer phase. Dispatch MUST follow up with
  // `ensureReachable(handle, { app, sessionId })` to subscribe the
  // session's hook-event stream. Standalone callers (CLI, raw provision
  // tests) get a reachable arkd but no event stream, which is the right
  // behaviour for their use case.

  async provision(opts: ProvisionOpts): Promise<ComputeHandle> {
    const name = (opts.tags?.name as string | undefined) ?? opts.tags?.computeName ?? `ec2-${Date.now()}`;
    const cfg = (opts.config ?? {}) as EC2ProvisionConfig;
    const log = opts.onLog ?? (() => {});

    const size = opts.size ?? "m";
    const arch = opts.arch ?? "x64";
    const region = cfg.region ?? "us-east-1";

    log("[ec2] Building cloud-init bundle...");
    const userData =
      cfg.userData ??
      (await this.helpers.buildUserData({
        idleMinutes: cfg.idleMinutes,
        isolation: cfg.isolation,
        conductorUrl: cfg.conductorUrl,
      }));

    log(`[ec2] Provisioning instance (${size}/${arch}) in ${region}...`);
    const result = await this.helpers.provisionStack(name, {
      size,
      arch,
      region,
      subnetId: cfg.subnetId,
      securityGroupId: cfg.securityGroupId,
      awsProfile: cfg.awsProfile,
      userData,
      tags: opts.tags,
      onOutput: (msg: string) => log(`[ec2] ${msg}`),
    });

    // SSM transport: target is instance_id, no IP required.
    const instanceId = result.instance_id;
    log(`[ec2] Instance ${instanceId} running. Waiting for SSM agent online...`);
    const ssmReady = await this.helpers.poll(
      async () => this.helpers.ssmCheckInstance({ instanceId, region, awsProfile: cfg.awsProfile }),
      { maxAttempts: 30, delayMs: 5000 },
    );
    if (!ssmReady) {
      throw new Error(`EC2Compute.provision: SSM agent never came online for ${instanceId}`);
    }

    log("[ec2] Waiting for cloud-init ready marker...");
    await this.helpers.poll(
      async () => {
        const res = await this.helpers.ssmExec({
          instanceId,
          command: "test -f /home/ubuntu/.ark-ready && echo ready",
          timeoutMs: 10_000,
          region,
          awsProfile: cfg.awsProfile,
        });
        return res.stdout.includes("ready");
      },
      { maxAttempts: 60, delayMs: 10_000 },
    );

    // Build a partial meta -- transport fields (arkdLocalPort, portForwardPid)
    // are filled in by setupTransport, called next. Done this way so the same
    // setupTransport body covers fresh-provision and rehydrate.
    const meta: EC2HandleMeta = {
      instanceId,
      publicIp: result.ip,
      privateIp: null,
      arkdLocalPort: 0,
      portForwardPid: null,
      region,
      awsProfile: cfg.awsProfile,
      stackName: result.stack_name,
      sgId: result.sg_id,
      size,
      arch,
    };
    const handle: ComputeHandle = {
      kind: this.kind,
      name,
      meta: { ec2: meta },
    };
    attachComputeMethods(handle, () => this.getArkdUrl(handle), this.clientFactory);

    await this.setupTransport(handle, { log });
    return handle;
  }

  // ── attachExistingHandle ─────────────────────────────────────────────────
  //
  // Synthesize an EC2 handle from a `compute` row that already represents a
  // provisioned instance. Returns null when the row hasn't been provisioned
  // (no instance_id in config) so the dispatcher falls through to a fresh
  // `provision()`. This is the fast path for `ec2-ssm`-style "live" rows --
  // status=running, instance_id known -- where re-running provisionStack
  // would attempt to build a duplicate CloudFormation stack and hang on
  // AWS SDK calls.
  //
  // Pure: maps row.config -> EC2HandleMeta. No AWS calls. ensureReachable
  // does the actual transport setup post-attach.

  attachExistingHandle(row: { name: string; status: string; config: Record<string, unknown> }): ComputeHandle | null {
    const cfg = row.config as Record<string, unknown>;
    const instanceId = cfg.instance_id as string | undefined;
    if (!instanceId) return null; // never provisioned -- fall through to provision()

    const meta: EC2HandleMeta = {
      instanceId,
      publicIp: (cfg.ip as string | undefined) ?? null,
      privateIp: null,
      // arkdLocalPort is 0 here; ensureReachable's setupTransport allocates a
      // fresh port (or reuses the live forward's port from cfg.arkd_local_forward_port).
      arkdLocalPort: typeof cfg.arkd_local_forward_port === "number" ? (cfg.arkd_local_forward_port as number) : 0,
      portForwardPid: null,
      region: (cfg.region as string | undefined) ?? "us-east-1",
      awsProfile: cfg.aws_profile as string | undefined,
      stackName: (cfg.stack_name as string | undefined) ?? `ark-compute-${row.name}`,
      sgId: cfg.sg_id as string | undefined,
      size: (cfg.size as string | undefined) ?? "m",
      arch: (cfg.arch as string | undefined) ?? "x64",
    };
    const handle: ComputeHandle = {
      kind: this.kind,
      name: row.name,
      meta: { ec2: meta },
    };
    return attachComputeMethods(handle, () => this.getArkdUrl(handle), this.clientFactory);
  }

  // ── ensureReachable ──────────────────────────────────────────────────────
  //
  // Bring the conductor's connection to arkd into a "ready" state on every
  // dispatch. Fresh provision feeds in the meta we just minted; rehydrate
  // (multi-stage flow, persisted handle from a previous run) feeds in the
  // existing meta. setupTransport reuses the live port-forward when the
  // recorded PID is still alive AND arkd answers /health through it, so
  // this method is idempotent.
  //
  // Each phase emits `provisioning_step` events on the session timeline
  // (started / ok / failed) so the web UI shows a uniform per-step trail.

  async ensureReachable(h: ComputeHandle, opts: EnsureReachableOpts): Promise<void> {
    await this.setupTransport(h, opts);
  }

  // ── setupTransport (private; shared by provision + ensureReachable) ──────
  //
  // Three phases:
  //   1. forward-tunnel  -- check for a live forward; reuse if healthy,
  //                         otherwise allocate a port and startPortForward.
  //   2. arkd-probe      -- /health on the (possibly fresh) local forward.
  //   3. events-consumer -- subscribe to arkd's NDJSON event stream so
  //                         hook events from the agent flow back to the
  //                         session timeline. startArkdEventsConsumer is
  //                         idempotent.
  //
  // Mutates `handle.meta.ec2.arkdLocalPort` + `portForwardPid` so subsequent
  // `getArkdUrl(h)` calls resolve to the live forward.
  //
  // ── Ordering invariant ───────────────────────────────────────────────────
  //
  // `provision` calls this with `{ log }` only -- no `app`, no `sessionId`.
  // That deliberately skips Phase 0 (the connectivity check, which would
  // double up on what `provision` itself already polled) AND Phase 3 (the
  // events-consumer, which has no session to attach to yet). The
  // dispatcher's contract picks up the slack: every dispatch runs
  // `Compute.ensureReachable(handle, { app, sessionId })` after either a
  // fresh `provision` or a rehydrate, and that pass starts the
  // events-consumer for the session that's about to launch.
  //
  // We intentionally chose Option B from the review feedback (see the
  // matching note on `provision` -- not Option A which would have threaded
  // sessionId into ProvisionOpts). Reason: standalone provision callers
  // (CLI `ark compute provision`, raw provision tests) genuinely have no
  // session, and Option B keeps `provision` honest about that. The cost is
  // that any future code path that calls `provision` without a follow-up
  // `ensureReachable` gets a working forward but no event stream -- callers
  // outside the dispatcher must call `ensureReachable` themselves if they
  // want hook events. `dispatch.runTargetLifecycle` enforces this for
  // dispatch (see its callers in services/dispatch).
  //
  // When `opts.app` and `opts.sessionId` are provided (the ensureReachable
  // case), each phase is wrapped in `provisionStep` so the timeline shows
  // a uniform per-step trail. When called from `provision` we don't yet
  // have a sessionId; the helpers do their own log-line streaming via
  // `opts.log` for that case.
  private async setupTransport(
    h: ComputeHandle,
    opts: { app?: AppContext; sessionId?: string; log?: (msg: string) => void; onLog?: (msg: string) => void } = {},
  ): Promise<void> {
    const meta = readMeta(h);
    const log = opts.log ?? opts.onLog ?? (() => {});
    const useStep = !!opts.app && !!opts.sessionId;
    const stepCtx = { compute: h.name, instanceId: meta.instanceId };

    // Phase 0 (rehydrate-only): connectivity-check via DescribeInstanceInformation.
    // Wait for the SSM agent to be Online before we waste time on forward
    // setup. Skipped on the fresh-provision path because `provision`
    // already polled ssmCheckInstance to confirm the instance is up
    // before it called us.
    //
    // Uses ssmWaitForReady (30 attempts x 5s = 150s budget) instead of a
    // single shot. The instance can be in the middle of a stop->start
    // cycle, was started outside Ark, or just genuinely takes 30-60s for
    // the SSM agent to register with the control plane after boot. A
    // single-shot check failed every time in those cases, leaving the
    // session stuck at "ensure-reachable failed".
    if (useStep) {
      await provisionStep(
        opts.app!,
        opts.sessionId!,
        "connectivity-check",
        async () => {
          const online = await this.helpers.ssmWaitForReady({
            instanceId: meta.instanceId,
            region: meta.region,
            awsProfile: meta.awsProfile,
          });
          if (!online) {
            throw new Error(
              `SSM agent did not become online for ${meta.instanceId} within 150s. ` +
                `Check the instance has the AmazonSSMManagedInstanceCore policy attached and ` +
                `the SSM agent is running (sudo systemctl status amazon-ssm-agent).`,
            );
          }
        },
        { retries: 1, retryBackoffMs: 1_000, context: stepCtx },
      );
    }

    // Phase 1: forward-tunnel. Per-session isolation (#423) -- always allocate
    // a fresh tunnel. The previous behaviour reused the compute handle's
    // recorded tunnel when its /health probe answered, which meant multiple
    // sessions on the same compute shared one tunnel. When that tunnel later
    // died (process exit, AWS SSM session timeout), every session reading
    // through it failed simultaneously. Fresh-per-call gives each session its
    // own tunnel keyed by its own local port; the port is persisted to
    // session.config below so concurrent sessions can't stomp each other.
    //
    // Cost: one `aws ssm start-session` process per session (~15 MB). Bounded
    // by your concurrency. Worth the isolation guarantee.
    //
    // We do NOT tear down the previously-recorded forward here -- the
    // compute handle's meta is shared by every dispatch on this compute,
    // so killing meta.portForwardPid could kill a sibling session's still-
    // active tunnel. Per-session pid tracking + cleanup lives in
    // session.config; the meta becomes a "latest fresh tunnel" pointer.
    // Orphan tunnels at the end of a session's life are a follow-up
    // concern, tracked separately.
    const tunnelFn = async (): Promise<{ localPort: number; portForwardPid: number; reused: boolean }> => {
      log("[ec2] Opening SSM port-forward to arkd...");
      const localPort = await this.helpers.allocatePort();
      const { pid } = await this.helpers.startPortForward({
        instanceId: meta.instanceId,
        region: meta.region,
        awsProfile: meta.awsProfile,
        localPort,
        remotePort: ARKD_REMOTE_PORT,
      });
      return { localPort, portForwardPid: pid, reused: false };
    };

    const tunnel = useStep
      ? await provisionStep(opts.app!, opts.sessionId!, "forward-tunnel", tunnelFn, { context: stepCtx })
      : await tunnelFn();

    // Persist the port + pid before the health probe so a probe failure
    // teardown can find the right pid to kill.
    meta.arkdLocalPort = tunnel.localPort;
    meta.portForwardPid = tunnel.portForwardPid;

    // Per-session port persistence (#423). Multiple sessions targeting the
    // same compute used to stomp each other's port via `compute.config.
    // arkd_local_forward_port`; the latest write would win and older
    // sessions would read a dead port if their tunnel was no longer the
    // canonical one. Writing the resolved local port to `session.config`
    // lets the conductor's arkd client pick a port that's known live for
    // THIS session.
    if (opts.app && opts.sessionId) {
      try {
        await opts.app.sessions.mergeConfig(opts.sessionId, {
          arkd_local_forward_port: tunnel.localPort,
        });
      } catch {
        // best-effort: tunnel still works via the fallback
      }
    }

    // Compute-level fallback for read paths without a session in scope
    // (compute panel metrics polling, status pollers between sessions).
    // The session-scoped port above is authoritative for live sessions;
    // this compute-level write is "the latest known-live tunnel for this
    // compute", refreshed whenever ANY session boots. With this set,
    // `getMetrics(compute)` reaches arkd through the session-allocated
    // tunnel rather than the unreachable direct EC2 IP.
    //
    // Cleared on EC2 stop / destroy in remote-arkd.ts so a future re-
    // provision doesn't reuse a port that no longer points anywhere.
    if (opts.app) {
      try {
        await opts.app.computes.mergeConfig(h.name, {
          arkd_local_forward_port: tunnel.localPort,
        });
      } catch {
        // best-effort
      }
    }

    // Phase 2: arkd /health probe through the (possibly fresh) forward.
    const arkdUrl = `http://localhost:${tunnel.localPort}`;
    const probeFn = async (): Promise<void> => {
      log(`[ec2] Waiting for arkd at ${arkdUrl}...`);
      const ready = await this.helpers.poll(() => this.helpers.fetchHealth(`${arkdUrl}/health`, 5000), {
        maxAttempts: 30,
        delayMs: 3000,
      });
      if (!ready) {
        // Tear the forward down so we don't leak the AWS CLI process on failure.
        await this.helpers.killPortForward(tunnel.portForwardPid);
        meta.portForwardPid = null;
        throw new Error(`EC2Compute.setupTransport: arkd never became reachable at ${arkdUrl}`);
      }
    };
    if (useStep) {
      await provisionStep(opts.app!, opts.sessionId!, "arkd-probe", probeFn, {
        context: { ...stepCtx, localPort: tunnel.localPort },
      });
    } else {
      await probeFn();
    }

    // Phase 3: arkd-events consumer subscribe. Idempotent: a second start
    // for the same compute is a no-op inside startArkdEventsConsumer.
    if (useStep) {
      await provisionStep(
        opts.app!,
        opts.sessionId!,
        "events-consumer-start",
        async () => {
          startArkdEventsConsumer(opts.app!, h.name, arkdUrl, process.env.ARK_ARKD_TOKEN ?? null);
        },
        { context: stepCtx },
      );
    }
    // When called from provision (no app yet), the events-consumer is started
    // by the dispatcher's later `ensureReachable` pass; nothing to do here.
  }

  // ── start / stop ─────────────────────────────────────────────────────────

  async start(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    // SSM transport: instance_id is the canonical address; IPs are
    // informational. We still record any private/public IPs the SDK
    // returns so legacy diagnostic logs / external tools have them.
    const { publicIp, privateIp } = await this.helpers.startInstance({
      instanceId: meta.instanceId,
      region: meta.region,
      awsProfile: meta.awsProfile,
    });

    // Kill any previous forward (defensive -- stop() should have handled it,
    // but a crash/reboot may have left a stale PID on the meta).
    if (meta.portForwardPid !== null && meta.portForwardPid > 0) {
      await this.helpers.killPortForward(meta.portForwardPid);
    }

    const { pid: portForwardPid } = await this.helpers.startPortForward({
      instanceId: meta.instanceId,
      region: meta.region,
      awsProfile: meta.awsProfile,
      localPort: meta.arkdLocalPort,
      remotePort: ARKD_REMOTE_PORT,
    });

    // Wait for arkd to come back through the forward before returning.
    const arkdUrl = `http://localhost:${meta.arkdLocalPort}`;
    const ready = await this.helpers.poll(() => this.helpers.fetchHealth(`${arkdUrl}/health`, 5000), {
      maxAttempts: 30,
      delayMs: 2000,
    });
    if (!ready) {
      await this.helpers.killPortForward(portForwardPid);
      throw new Error(`EC2Compute.start: arkd never came back at ${arkdUrl}`);
    }

    // Mutate the caller's handle in place so subsequent calls see the
    // refreshed IP / forward PID. The DB-backed handle store used by
    // dispatch persists this via a separate path.
    meta.publicIp = publicIp;
    if (privateIp) meta.privateIp = privateIp;
    meta.portForwardPid = portForwardPid;
  }

  async stop(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);

    // Tear the forward down first -- stopping the instance drops SSM anyway,
    // but killing the forward explicitly releases the local port.
    if (meta.portForwardPid !== null && meta.portForwardPid > 0) {
      await this.helpers.killPortForward(meta.portForwardPid);
      meta.portForwardPid = null;
    }

    await this.helpers.stopInstance({
      instanceId: meta.instanceId,
      region: meta.region,
      awsProfile: meta.awsProfile,
    });
  }

  // ── destroy ──────────────────────────────────────────────────────────────

  async destroy(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);

    // Close the forward first so the local port isn't held through the
    // (potentially slow) terminate call.
    if (meta.portForwardPid !== null && meta.portForwardPid > 0) {
      await this.helpers.killPortForward(meta.portForwardPid);
      meta.portForwardPid = null;
    }

    await this.helpers.destroyStack(h.name, {
      region: meta.region,
      awsProfile: meta.awsProfile,
      instance_id: meta.instanceId,
      sg_id: meta.sgId,
      stackName: meta.stackName,
    });
  }

  // ── getArkdUrl ───────────────────────────────────────────────────────────

  getArkdUrl(h: ComputeHandle): string {
    const meta = readMeta(h);
    return `http://localhost:${meta.arkdLocalPort}`;
  }

  // ── resolveWorkdir ───────────────────────────────────────────────────────
  //
  // Translate the conductor-side workdir path to where the cloned worktree
  // lives on the remote host. Pure transform; no I/O. Mirrors the legacy
  // `RemoteWorktreeProvider.resolveWorkdir` shape:
  //   `${REMOTE_HOME}/Projects/<sessionId>/<repoBasename>`
  // The path is session-scoped so concurrent / sequential sessions on the
  // same compute don't collide. We prefer `session.config.remoteRepo` (the
  // clone-on-remote URL) over `session.repo` (conductor-local path). If
  // neither is set we return null and the caller falls back to
  // `session.workdir`.
  //
  // `remoteHome` is read off `handle.meta.ec2` for forward-compat with
  // custom AMIs that ship a different default user; today the EC2 provision
  // path doesn't write the field, so the fallback `/home/ubuntu` matches
  // the legacy `REMOTE_USER` constant.

  resolveWorkdir(h: ComputeHandle, session: Session): string | null {
    const cloneSource = (session.config as { remoteRepo?: string } | null | undefined)?.remoteRepo ?? session.repo;
    if (!cloneSource) return null;
    const repoBasename =
      cloneSource
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") ?? "project";
    const remoteHome = (h.meta.ec2 as { remoteHome?: string } | undefined)?.remoteHome ?? REMOTE_HOME;
    return `${remoteHome}/Projects/${session.id}/${repoBasename}`;
  }

  // ── prepareWorkspace ─────────────────────────────────────────────────────
  //
  // Per-session workspace setup on the remote host: mkdir the parent and
  // git clone the source into the leaf. Routes through arkd via the live
  // SSM port-forward that `ensureReachable` set up; no out-of-band
  // ops at this layer.
  //
  // Returns silently when either `source` or `remoteWorkdir` is null --
  // the dispatcher computes both upstream from session config and the
  // bare-worktree path is meaningful (no clone, agent runs against an
  // empty workdir; misconfig surfaces at the agent stage rather than
  // here). Mirror the legacy `RemoteWorktreeProvider.launch` body.
  //
  // Ordering invariant: `ensureReachable` must have run on `h` before
  // this call so `getArkdUrl(h)` resolves to the live local-forward
  // port. `runTargetLifecycle` in the dispatcher enforces this.

  /**
   * Test-only: swap the helper that performs `mkdir -p` + `git clone`
   * via arkd. Default is the production `cloneWorkspaceViaArkd` which
   * constructs an `ArkdClient` against `getArkdUrl(handle)`.
   */
  setCloneHelperForTesting(fn: typeof cloneWorkspaceViaArkd): void {
    this.cloneHelper = fn;
  }

  private cloneHelper: typeof cloneWorkspaceViaArkd = cloneWorkspaceViaArkd;

  async prepareWorkspace(h: ComputeHandle, opts: PrepareWorkspaceOpts): Promise<void> {
    if (!opts.source || !opts.remoteWorkdir) return;
    const arkdUrl = this.getArkdUrl(h);
    const arkdToken = process.env.ARK_ARKD_TOKEN ?? null;
    await this.cloneHelper({
      arkdUrl,
      arkdToken,
      source: opts.source,
      remoteWorkdir: opts.remoteWorkdir,
    });
  }

  // ── flushPlacement ──────────────────────────────────────────────────────
  //
  // Replay the dispatcher's queued typed-secret ops onto a real
  // `EC2PlacementCtx` over the SSM transport. Lifted byte-for-byte from
  // the legacy `RemoteArkdBase.flushDeferredPlacement` body so the
  // dispatch behaviour for live EC2 sessions stays identical.
  //
  // Behaviour:
  //   - No-op when the deferred ctx has no queued ops (env-only sessions, or
  //     the dispatcher's placement branch was disabled).
  //   - THROWS when there ARE queued file/provisioner ops but the handle
  //     meta still lacks an `instanceId`. Pre-fix this only logged a warning
  //     and dropped the queued ops on the floor, leading to silent failures
  //     where the agent ran without its SSH key / kubeconfig / generic blob
  //     and `dispatch_failed` was never reported. The throw propagates up
  //     through the dispatcher so `kickDispatch` marks the dispatch failed
  //     and the user sees it.
  //
  // Reads from `handle.meta.ec2`:
  //   - `instanceId` -- canonical SSM target
  //   - `region`, `awsProfile` -- forwarded into the SSM client.
  //
  // Ordering invariant: `ensureReachable` must have run on `h` first so the
  // forward + arkd are live. The placement ctx talks SSM directly to the
  // instance and does not flow through arkd; the forward is not strictly
  // needed for this method, but we still order behind ensureReachable to
  // match the rest of the dispatch lifecycle.

  /**
   * Test-only: swap the helper that constructs an EC2PlacementCtx from
   * meta. Mirrors `setCloneHelperForTesting` -- the test injects a
   * recording stub so we can assert which fields are read off
   * `handle.meta.ec2` and which deps are passed to the ctx without
   * exercising the real ssm/tar pipeline.
   */
  setPlacementCtxFactoryForTesting(
    fn: (deps: { instanceId: string; region: string; awsProfile?: string }) => PlacementCtx,
  ): void {
    this.placementCtxFactory = fn;
  }

  private placementCtxFactory: (deps: { instanceId: string; region: string; awsProfile?: string }) => PlacementCtx = (
    deps,
  ) => new EC2PlacementCtx(deps);

  async flushPlacement(h: ComputeHandle, opts: FlushPlacementOpts): Promise<void> {
    const deferred = opts.placement;
    if (!deferred.hasDeferred()) {
      logDebug("compute", `flushPlacement: no queued ops on '${h.name}', skipping`);
      return;
    }
    const meta = readMeta(h);
    if (!meta.instanceId) {
      throw new Error(
        `flushPlacement: compute '${h.name}' has no instanceId at launch time but ` +
          `${deferred.queuedOps.length} placement op(s) are queued. Cannot proceed.`,
      );
    }
    const realCtx = this.placementCtxFactory({
      instanceId: meta.instanceId,
      region: meta.region,
      awsProfile: meta.awsProfile,
    });
    logInfo(
      "compute",
      `[trace:flushPlacement] compute=${h.name} instanceId=${meta.instanceId} ops=${deferred.queuedOps.length}`,
    );
    await deferred.flush(realCtx);
    logInfo("compute", `[trace:flushPlacement] done compute=${h.name}`);
  }

  // ── snapshot / restore (deferred) ────────────────────────────────────────

  async snapshot(_h: ComputeHandle): Promise<Snapshot> {
    throw new NotSupportedError(this.kind, "snapshot");
  }

  async restore(_s: Snapshot): Promise<ComputeHandle> {
    throw new NotSupportedError(this.kind, "restore");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function readMeta(h: ComputeHandle): EC2HandleMeta {
  const meta = (h.meta as Record<string, unknown>).ec2 as EC2HandleMeta | undefined;
  if (!meta) {
    throw new Error(`EC2Compute: handle ${h.name} is missing meta.ec2 -- was it produced by provision()?`);
  }
  return meta;
}
