/**
 * EC2Compute -- Compute impl that lives on an AWS EC2 instance.
 *
 * Transport: SSH runs over an SSM Session Manager tunnel; the conductor
 * does not need direct network reachability to the instance, no public
 * IP is required, and the security group has no inbound rules. Callers
 * never see AWS-level networking details -- arkd is reached through a
 * local SSH-forwarded port.
 *
 * Lifecycle overview:
 *
 *   provision: ensure SSH key -> provisionStack (RunInstances + IAM SSM
 *              role + SG + key) -> wait for SSH-via-SSM reachability ->
 *              wait for cloud-init "ready" marker -> open a forward SSH
 *              tunnel (over SSM) from a local ephemeral port to arkd's
 *              internal :19300 -> wait for arkd /health through the
 *              tunnel -> return a handle whose `meta.ec2` captures
 *              everything needed to resume, tear down, and talk to arkd.
 *
 *   getArkdUrl: always returns http://localhost:<arkdLocalPort>. The
 *               conductor talks to arkd via the SSM-tunneled SSH forward;
 *               the instance ID is the canonical address, no IP needed.
 *
 *   start / stop: map to EC2 StartInstances / StopInstances. `start`
 *                 waits until the instance is running, then re-establishes
 *                 the tunnel (the local port stays stable across restarts).
 *
 *   destroy: TerminateInstances (via `destroyStack`), close the tunnel,
 *            drop the security group / key pair the stack created.
 *
 * Snapshot / restore: deferred. Both throw NotSupportedError with
 * `capabilities.snapshot = true` still reported so dispatch can hint
 * at the eventual shape -- tests assert both.
 *
 * Isolation composition: EC2Compute pairs with any Isolation (DirectIsolation,
 * DockerIsolation, DevcontainerIsolation, DockerComposeIsolation). The
 * isolation's container / devcontainer / compose logic is completely
 * unchanged -- the Isolation just calls `compute.getArkdUrl(h)` and talks
 * to arkd through the
 * tunnel exactly like LocalCompute. That works because arkd inside the EC2
 * instance owns every container it launches via its own docker / devcontainer
 * / compose machinery, and those all listen back on the instance's loopback
 * -- the tunnel's :19300 -> :19300 forwarding picks them up transparently.
 *
 * All AWS and SSH side-effects go through the injectable `EC2ComputeHelpers`
 * surface. Production wiring passes the real functions from `../providers/ec2/*`;
 * tests swap in stubs to avoid hitting AWS. We intentionally import the
 * helpers lazily so the AWS SDK is not pulled into cold-start paths that
 * never provision an EC2 compute.
 */

import { spawn } from "child_process";

import { REMOTE_HOME, REMOTE_USER } from "../providers/ec2/constants.js";
import type { AppContext } from "../../core/app.js";
import type { Session } from "../../types/session.js";
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
} from "./types.js";
import { NotSupportedError } from "./types.js";
import { cloneWorkspaceViaArkd } from "./workspace-clone.js";
import { logDebug, logInfo } from "../../core/observability/structured-log.js";
import { provisionStep } from "../../core/services/provisioning-steps.js";
import { startArkdEventsConsumer } from "../../core/conductor/arkd-events-consumer.js";
import { EC2PlacementCtx } from "../providers/ec2/placement-ctx.js";
import type { PlacementCtx } from "../../core/secrets/placement-types.js";

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
  /** Local ephemeral host port the SSH tunnel listens on. */
  arkdLocalPort: number;
  /** PID of the backgrounded `ssh -N -L` tunnel process. */
  sshPid: number | null;
  /** Absolute path of the SSH private key (ed25519) used for provisioning. */
  sshKeyPath: string;
  /** AWS region the stack lives in. Required for SSM session establishment. */
  region: string;
  /** Optional AWS profile for credentials. */
  awsProfile?: string;
  /** Stack name returned by `provisionStack` (used by `destroyStack`). */
  stackName: string;
  /** Security group id if we created a fresh one; undefined if we reused. */
  sgId?: string;
  /** Key pair name if we created a fresh one; undefined if we reused. */
  keyName?: string;
  /** Instance size label (e.g. "m"). */
  size: string;
  /** Architecture label ("x64" / "arm"). */
  arch: string;
}

// ── Injectable helper surface (DI for tests) ────────────────────────────────

/**
 * The set of EC2 / SSH side-effects EC2Compute depends on. Tests swap all of
 * these via `setHelpersForTesting` so no real AWS / SSH call ever fires.
 *
 * Kept deliberately minimal: each helper mirrors exactly one external
 * operation, which makes assertions trivial and keeps the production wiring
 * a straight passthrough.
 */
export interface EC2ComputeHelpers {
  /** Ensure an ed25519 SSH key exists for the given host name. */
  generateSshKey: (hostName: string) => Promise<{ publicKeyPath: string; privateKeyPath: string }>;
  /**
   * One-shot SSH (over SSM) command for readiness probes.
   * Returns exitCode 0 on success; never throws. The host arg is an
   * EC2 instance_id; SSM provides the underlying transport.
   */
  sshExec: (
    key: string,
    instanceId: string,
    cmd: string,
    opts?: { timeout?: number; region?: string; awsProfile?: string },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
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
    key_name?: string;
  }>;
  /** TerminateInstances + clean up SG + key pair. */
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
   * Spawn a background `ssh -N -L <localPort>:localhost:19300` process
   * (tunneled through SSM Session Manager) and return its PID. The
   * returned PID is stored on `handle.meta.ec2.sshPid`.
   */
  openSshTunnel: (opts: {
    keyPath: string;
    instanceId: string;
    region: string;
    awsProfile?: string;
    localPort: number;
    remotePort: number;
  }) => number;
  /** Kill a PID (SIGTERM). Swallows ESRCH -- tunnel may already be gone. */
  killSshTunnel: (pid: number) => void;
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

/** Constants used by the default tunnel spawn. */
const SSH_TUNNEL_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ExitOnForwardFailure=yes",
];

async function defaultFetchHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

function defaultOpenSshTunnel(opts: {
  keyPath: string;
  instanceId: string;
  region: string;
  awsProfile?: string;
  localPort: number;
  remotePort: number;
}): number {
  // `-N` = no remote command; `-L local:host:remote` forwards.
  // We deliberately do NOT pass `-f` here: Node can't reliably capture the PID
  // of a self-daemonised ssh. Instead we spawn detached + unref so the process
  // survives this process's event loop while still exposing a PID we can kill.
  // Transport is SSH-over-SSM via the AWS-StartSSHSession document.
  const profilePart = opts.awsProfile ? ` --profile ${opts.awsProfile}` : "";
  const proxy =
    `aws ssm start-session --target %h ` +
    `--document-name AWS-StartSSHSession ` +
    `--parameters portNumber=%p ` +
    `--region ${opts.region}${profilePart}`;
  const args = [
    "-i",
    opts.keyPath,
    "-N",
    ...SSH_TUNNEL_OPTS,
    "-o",
    `ProxyCommand=${proxy}`,
    "-L",
    `${opts.localPort}:localhost:${opts.remotePort}`,
    `${REMOTE_USER}@${opts.instanceId}`,
  ];
  const child = spawn("ssh", args, { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid ?? -1;
}

function defaultKillSshTunnel(pid: number): void {
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    logDebug("compute", "already gone -- best-effort.");
  }
}

async function defaultStartInstance(opts: {
  instanceId: string;
  region: string;
  awsProfile?: string;
}): Promise<{ publicIp: string | null; privateIp: string | null }> {
  const { EC2Client, StartInstancesCommand, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
  const { fromIni } = await import("@aws-sdk/credential-providers");
  const { poll } = await import("../util.js");
  const client = new EC2Client({
    region: opts.region,
    ...(opts.awsProfile ? { credentials: fromIni({ profile: opts.awsProfile }) } : {}),
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
  const { fromIni } = await import("@aws-sdk/credential-providers");
  const client = new EC2Client({
    region: opts.region,
    ...(opts.awsProfile ? { credentials: fromIni({ profile: opts.awsProfile }) } : {}),
  });
  await client.send(new StopInstancesCommand({ InstanceIds: [opts.instanceId] }));
}

async function defaultDescribeInstance(opts: {
  instanceId: string;
  region: string;
  awsProfile?: string;
}): Promise<{ publicIp: string | null; privateIp: string | null }> {
  const { EC2Client, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
  const { fromIni } = await import("@aws-sdk/credential-providers");
  const client = new EC2Client({
    region: opts.region,
    ...(opts.awsProfile ? { credentials: fromIni({ profile: opts.awsProfile }) } : {}),
  });
  const desc = await client.send(new DescribeInstancesCommand({ InstanceIds: [opts.instanceId] }));
  const inst = desc.Reservations?.[0]?.Instances?.[0];
  return {
    publicIp: inst?.PublicIpAddress ?? null,
    privateIp: inst?.PrivateIpAddress ?? null,
  };
}

const DEFAULT_HELPERS: EC2ComputeHelpers = {
  generateSshKey: (async (hostName) => {
    const { generateSshKey } = await import("../providers/ec2/ssh.js");
    return generateSshKey(hostName);
  }) as EC2ComputeHelpers["generateSshKey"],
  sshExec: (async (key, instanceId, cmd, opts) => {
    const { sshExec } = await import("../providers/ec2/ssh.js");
    return sshExec(key, instanceId, cmd, opts);
  }) as EC2ComputeHelpers["sshExec"],
  buildUserData: (async (opts) => {
    const { buildUserData } = await import("../providers/ec2/cloud-init.js");
    return buildUserData(opts);
  }) as EC2ComputeHelpers["buildUserData"],
  provisionStack: (async (hostName, opts) => {
    const { provisionStack } = await import("../providers/ec2/provision.js");
    return provisionStack(hostName, opts as any);
  }) as EC2ComputeHelpers["provisionStack"],
  destroyStack: (async (hostName, opts) => {
    const { destroyStack } = await import("../providers/ec2/provision.js");
    return destroyStack(hostName, opts as any);
  }) as EC2ComputeHelpers["destroyStack"],
  startInstance: defaultStartInstance,
  stopInstance: defaultStopInstance,
  describeInstance: defaultDescribeInstance,
  openSshTunnel: defaultOpenSshTunnel,
  killSshTunnel: defaultKillSshTunnel,
  allocatePort: (async () => {
    const { allocatePort } = await import("../../core/config/port-allocator.js");
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
  };

  private helpers: EC2ComputeHelpers = DEFAULT_HELPERS;

  constructor(private readonly app: AppContext) {}

  /**
   * Test-only: swap in stubs for every EC2 / SSH side-effect. Partial
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

    log(`[ec2] Ensuring SSH key for ${name}...`);
    const { privateKeyPath } = await this.helpers.generateSshKey(name);

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
      sshKeyPath: privateKeyPath,
      onOutput: (msg: string) => log(`[ec2] ${msg}`),
    });

    // SSM transport: target is instance_id, no IP required.
    const instanceId = result.instance_id;
    log(`[ec2] Instance ${instanceId} running. Waiting for SSH (via SSM)...`);
    const sshReady = await this.helpers.poll(
      async () => {
        const res = await this.helpers.sshExec(privateKeyPath, instanceId, "echo ok", {
          timeout: 15_000,
          region,
          awsProfile: cfg.awsProfile,
        });
        return res.exitCode === 0;
      },
      { maxAttempts: 30, delayMs: 5000 },
    );
    if (!sshReady) {
      throw new Error(`EC2Compute.provision: SSH (via SSM) never became reachable for ${instanceId}`);
    }

    log("[ec2] Waiting for cloud-init ready marker...");
    await this.helpers.poll(
      async () => {
        const res = await this.helpers.sshExec(
          privateKeyPath,
          instanceId,
          "test -f /home/ubuntu/.ark-ready && echo ready",
          { timeout: 10_000, region, awsProfile: cfg.awsProfile },
        );
        return res.stdout.includes("ready");
      },
      { maxAttempts: 60, delayMs: 10_000 },
    );

    // Build a partial meta -- transport fields (arkdLocalPort, sshPid) are
    // filled in by setupTransport, called next. Done this way so the same
    // setupTransport body covers fresh-provision and rehydrate.
    const meta: EC2HandleMeta = {
      instanceId,
      publicIp: result.ip,
      privateIp: null,
      arkdLocalPort: 0,
      sshPid: null,
      sshKeyPath: privateKeyPath,
      region,
      awsProfile: cfg.awsProfile,
      stackName: result.stack_name,
      sgId: result.sg_id,
      keyName: result.key_name,
      size,
      arch,
    };
    const handle: ComputeHandle = {
      kind: this.kind,
      name,
      meta: { ec2: meta },
    };

    await this.setupTransport(handle, { log });
    return handle;
  }

  // ── ensureReachable ──────────────────────────────────────────────────────
  //
  // Bring the conductor's connection to arkd into a "ready" state on every
  // dispatch. Fresh provision feeds in the meta we just minted; rehydrate
  // (multi-stage flow, persisted handle from a previous run) feeds in the
  // existing meta. setupTransport reuses the live ssh -L process when the
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
  //   1. forward-tunnel  -- check for a live tunnel; reuse if healthy,
  //                         otherwise allocate a port and openSshTunnel.
  //   2. arkd-probe      -- /health on the (possibly fresh) local tunnel.
  //   3. events-consumer -- subscribe to arkd's NDJSON event stream so
  //                         hook events from the agent flow back to the
  //                         session timeline. startArkdEventsConsumer is
  //                         idempotent.
  //
  // Mutates `handle.meta.ec2.arkdLocalPort` + `sshPid` so subsequent
  // `getArkdUrl(h)` calls resolve to the live tunnel.
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
  // `ensureReachable` gets a working tunnel but no event stream -- callers
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

    // Phase 0 (rehydrate-only): connectivity-check. Fail fast if the SSM
    // transport itself isn't alive before we waste time on tunnel setup.
    // Skipped on the fresh-provision path because `provision` already polled
    // sshExec to confirm the instance is up before it called us, and adding
    // a second connectivity hit there would change the existing test's
    // observable poll order.
    if (useStep) {
      await provisionStep(
        opts.app!,
        opts.sessionId!,
        "connectivity-check",
        async () => {
          const res = await this.helpers.sshExec(meta.sshKeyPath, meta.instanceId, "echo ok", {
            timeout: 15_000,
            region: meta.region,
            awsProfile: meta.awsProfile,
          });
          if (res.exitCode !== 0) throw new Error(`ssh returned non-zero exit ${res.exitCode}`);
        },
        { retries: 1, retryBackoffMs: 1_000, context: stepCtx },
      );
    }

    // Phase 1: forward-tunnel. Reuse the existing one when healthy.
    const tunnelFn = async (): Promise<{ localPort: number; sshPid: number; reused: boolean }> => {
      // Idempotent reuse: if we already recorded a tunnel and arkd answers
      // through it, keep using it. This is the rehydrate-after-multi-stage
      // path -- a stale meta from 5 minutes ago whose ssh process is still
      // alive should not provoke a tunnel respawn.
      if (meta.sshPid !== null && meta.sshPid > 0 && meta.arkdLocalPort > 0) {
        const probeUrl = `http://localhost:${meta.arkdLocalPort}`;
        const live = await this.helpers.fetchHealth(`${probeUrl}/health`, 2000);
        if (live) {
          return { localPort: meta.arkdLocalPort, sshPid: meta.sshPid, reused: true };
        }
        // Old tunnel is dead -- tear down the recorded PID before respawning
        // so we don't leak the orphaned ssh process.
        this.helpers.killSshTunnel(meta.sshPid);
      }

      log("[ec2] Opening SSH tunnel (via SSM) to arkd...");
      const localPort = await this.helpers.allocatePort();
      const sshPid = this.helpers.openSshTunnel({
        keyPath: meta.sshKeyPath,
        instanceId: meta.instanceId,
        region: meta.region,
        awsProfile: meta.awsProfile,
        localPort,
        remotePort: ARKD_REMOTE_PORT,
      });
      return { localPort, sshPid, reused: false };
    };

    const tunnel = useStep
      ? await provisionStep(opts.app!, opts.sessionId!, "forward-tunnel", tunnelFn, { context: stepCtx })
      : await tunnelFn();

    // Persist the port + pid before the health probe so a probe failure
    // teardown can find the right pid to kill.
    meta.arkdLocalPort = tunnel.localPort;
    meta.sshPid = tunnel.sshPid;

    // Phase 2: arkd /health probe through the (possibly fresh) tunnel.
    const arkdUrl = `http://localhost:${tunnel.localPort}`;
    const probeFn = async (): Promise<void> => {
      log(`[ec2] Waiting for arkd at ${arkdUrl}...`);
      const ready = await this.helpers.poll(() => this.helpers.fetchHealth(`${arkdUrl}/health`, 5000), {
        maxAttempts: 30,
        delayMs: 3000,
      });
      if (!ready) {
        // Tear the tunnel down so we don't leak an ssh process on failure.
        this.helpers.killSshTunnel(tunnel.sshPid);
        meta.sshPid = null;
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

    // Kill any previous tunnel (defensive -- stop() should have handled it,
    // but a crash/reboot may have left a stale PID on the meta).
    if (meta.sshPid !== null && meta.sshPid > 0) {
      this.helpers.killSshTunnel(meta.sshPid);
    }

    const sshPid = this.helpers.openSshTunnel({
      keyPath: meta.sshKeyPath,
      instanceId: meta.instanceId,
      region: meta.region,
      awsProfile: meta.awsProfile,
      localPort: meta.arkdLocalPort,
      remotePort: ARKD_REMOTE_PORT,
    });

    // Wait for arkd to come back through the tunnel before returning.
    const arkdUrl = `http://localhost:${meta.arkdLocalPort}`;
    const ready = await this.helpers.poll(() => this.helpers.fetchHealth(`${arkdUrl}/health`, 5000), {
      maxAttempts: 30,
      delayMs: 2000,
    });
    if (!ready) {
      this.helpers.killSshTunnel(sshPid);
      throw new Error(`EC2Compute.start: arkd never came back at ${arkdUrl}`);
    }

    // Mutate the caller's handle in place so subsequent calls see the
    // refreshed IP / tunnel PID. The DB-backed handle store used by
    // dispatch persists this via a separate path.
    meta.publicIp = publicIp;
    if (privateIp) meta.privateIp = privateIp;
    meta.sshPid = sshPid;
  }

  async stop(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);

    // Tear the tunnel down first -- stopping the instance drops SSH anyway,
    // but killing the tunnel explicitly releases the local port.
    if (meta.sshPid !== null && meta.sshPid > 0) {
      this.helpers.killSshTunnel(meta.sshPid);
      meta.sshPid = null;
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

    // Close the tunnel first so the local port isn't held through the
    // (potentially slow) terminate call.
    if (meta.sshPid !== null && meta.sshPid > 0) {
      this.helpers.killSshTunnel(meta.sshPid);
      meta.sshPid = null;
    }

    await this.helpers.destroyStack(h.name, {
      region: meta.region,
      awsProfile: meta.awsProfile,
      instance_id: meta.instanceId,
      sg_id: meta.sgId,
      key_name: meta.keyName,
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
  // SSH-over-SSM tunnel that `ensureReachable` set up; no SSH out-of-band
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
  // `EC2PlacementCtx` over the live SSH-over-SSM transport. Lifted byte-for-
  // byte from the legacy `RemoteArkdBase.flushDeferredPlacement` body so the
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
  //   - `sshKeyPath` -- private key generated by `provision()` (same path
  //     `sshKeyPath(handle.name)` returns; the legacy code went through the
  //     helper, the new code reads the field that was populated by it).
  //   - `region`, `awsProfile` -- forwarded into the SSM proxy command.
  //
  // Ordering invariant: `ensureReachable` must have run on `h` first so the
  // SSH tunnel + arkd are live. The placement ctx talks SSH-over-SSM
  // directly to the instance and does not flow through arkd; the tunnel is
  // not strictly needed for this method, but we still order behind
  // ensureReachable to match the rest of the dispatch lifecycle.

  /**
   * Test-only: swap the helper that constructs an EC2PlacementCtx from
   * meta. Mirrors `setCloneHelperForTesting` -- the test injects a
   * recording stub so we can assert which fields are read off
   * `handle.meta.ec2` and which deps are passed to the ctx without
   * exercising the real ssh/tar pipeline.
   */
  setPlacementCtxFactoryForTesting(
    fn: (deps: { sshKeyPath: string; instanceId: string; region: string; awsProfile?: string }) => PlacementCtx,
  ): void {
    this.placementCtxFactory = fn;
  }

  private placementCtxFactory: (deps: {
    sshKeyPath: string;
    instanceId: string;
    region: string;
    awsProfile?: string;
  }) => PlacementCtx = (deps) => new EC2PlacementCtx(deps);

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
      sshKeyPath: meta.sshKeyPath,
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
