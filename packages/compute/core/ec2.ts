/**
 * EC2Compute -- Wave 3 Compute impl that lives on an AWS EC2 instance.
 *
 * Lifecycle overview:
 *
 *   provision: ensure SSH key -> provisionStack (RunInstances + SG + key) ->
 *              wait for SSH reachability -> wait for cloud-init "ready" marker
 *              -> open a forward SSH tunnel from a local ephemeral port to
 *              arkd's internal :19300 -> wait for arkd /health through the
 *              tunnel -> return a handle whose `meta.ec2` captures everything
 *              needed to resume, tear down, and talk to arkd.
 *
 *   getArkdUrl: always returns http://localhost:<arkdLocalPort>. The conductor
 *               talks to arkd via the tunnel; the remote instance IP never
 *               leaks into the URL, which means callers don't need AWS-level
 *               reachability to speak to a provisioned compute.
 *
 *   start / stop: map to EC2 StartInstances / StopInstances. `start` waits
 *                 until a fresh public IP is assigned, then re-establishes
 *                 the tunnel (the local port stays stable across restarts).
 *
 *   destroy: TerminateInstances (via `destroyStack`), close the tunnel,
 *            drop the security group / key pair the stack created.
 *
 * Snapshot / restore: deferred to Phase 3. Both throw NotSupportedError
 * with `capabilities.snapshot = true` still reported so dispatch can hint
 * at the eventual shape -- tests assert both.
 *
 * Runtime composition: EC2Compute pairs with any Runtime (DirectRuntime,
 * DockerRuntime, DevcontainerRuntime, DockerComposeRuntime). The runtime's
 * container / devcontainer / compose logic is completely unchanged -- the
 * Runtime just calls `compute.getArkdUrl(h)` and talks to arkd through the
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

import type { AppContext } from "../../core/app.js";
import type { Compute, ComputeCapabilities, ComputeHandle, ComputeKind, ProvisionOpts, Snapshot } from "./types.js";
import { NotSupportedError } from "./types.js";
import { logDebug } from "../../core/observability/structured-log.js";

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
  /** AWS instance id returned by RunInstances. */
  instanceId: string;
  /** Current public IPv4 (null for private-subnet launches). */
  publicIp: string | null;
  /** Private IPv4 on the VPC. */
  privateIp: string | null;
  /** Local ephemeral host port the SSH tunnel listens on. */
  arkdLocalPort: number;
  /** PID of the backgrounded `ssh -N -L` tunnel process. */
  sshPid: number | null;
  /** Absolute path of the SSH private key (ed25519) used for provisioning. */
  sshKeyPath: string;
  /** AWS region the stack lives in. */
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
  /** One-shot SSH command for readiness probes (returns exitCode 0 on success). */
  sshExec: (
    key: string,
    ip: string,
    cmd: string,
    opts?: { timeout?: number },
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
   * Spawn a background `ssh -N -L <localPort>:localhost:19300` process and
   * return its PID. The returned PID is stored on `handle.meta.ec2.sshPid`.
   */
  openSshTunnel: (opts: { keyPath: string; ip: string; localPort: number; remotePort: number }) => number;
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

function defaultOpenSshTunnel(opts: { keyPath: string; ip: string; localPort: number; remotePort: number }): number {
  // `-N` = no remote command; `-L local:host:remote` forwards.
  // We deliberately do NOT pass `-f` here: Node can't reliably capture the PID
  // of a self-daemonised ssh. Instead we spawn detached + unref so the process
  // survives this process's event loop while still exposing a PID we can kill.
  const args = [
    "-i",
    opts.keyPath,
    "-N",
    ...SSH_TUNNEL_OPTS,
    "-L",
    `${opts.localPort}:localhost:${opts.remotePort}`,
    `ubuntu@${opts.ip}`,
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
  sshExec: (async (key, ip, cmd, opts) => {
    const { sshExec } = await import("../providers/ec2/ssh.js");
    return sshExec(key, ip, cmd, opts);
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

  private app!: AppContext;
  private helpers: EC2ComputeHelpers = DEFAULT_HELPERS;

  setApp(app: AppContext): void {
    this.app = app;
  }

  /**
   * Test-only: swap in stubs for every EC2 / SSH side-effect. Partial
   * overrides merge over DEFAULT_HELPERS, so a test only has to stub what
   * it cares about.
   */
  setHelpersForTesting(helpers: Partial<EC2ComputeHelpers>): void {
    this.helpers = { ...DEFAULT_HELPERS, ...helpers };
  }

  // ── provision ────────────────────────────────────────────────────────────

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
      onOutput: (msg: string) => log(`[ec2] pulumi: ${msg}`),
    });

    const ip = result.ip;
    if (!ip) {
      throw new Error(`EC2Compute.provision: instance ${result.instance_id} has no IP -- cannot reach arkd`);
    }

    log(`[ec2] Instance ${result.instance_id} running at ${ip}. Waiting for SSH...`);
    const sshReady = await this.helpers.poll(
      async () => {
        const res = await this.helpers.sshExec(privateKeyPath, ip, "echo ok", { timeout: 15_000 });
        return res.exitCode === 0;
      },
      { maxAttempts: 30, delayMs: 5000 },
    );
    if (!sshReady) {
      throw new Error(`EC2Compute.provision: SSH never became reachable on ${ip}`);
    }

    log("[ec2] Waiting for cloud-init ready marker...");
    await this.helpers.poll(
      async () => {
        const res = await this.helpers.sshExec(privateKeyPath, ip, "test -f /home/ubuntu/.ark-ready && echo ready", {
          timeout: 10_000,
        });
        return res.stdout.includes("ready");
      },
      { maxAttempts: 60, delayMs: 10_000 },
    );

    log("[ec2] Opening SSH tunnel to arkd...");
    const arkdLocalPort = await this.helpers.allocatePort();
    const sshPid = this.helpers.openSshTunnel({
      keyPath: privateKeyPath,
      ip,
      localPort: arkdLocalPort,
      remotePort: ARKD_REMOTE_PORT,
    });

    const arkdUrl = `http://localhost:${arkdLocalPort}`;
    log(`[ec2] Waiting for arkd at ${arkdUrl}...`);
    const arkdReady = await this.helpers.poll(() => this.helpers.fetchHealth(`${arkdUrl}/health`, 5000), {
      maxAttempts: 30,
      delayMs: 3000,
    });
    if (!arkdReady) {
      // Tear the tunnel down so we don't leak an ssh process on failure.
      this.helpers.killSshTunnel(sshPid);
      throw new Error(`EC2Compute.provision: arkd never became reachable at ${arkdUrl}`);
    }

    const meta: EC2HandleMeta = {
      instanceId: result.instance_id,
      publicIp: ip,
      privateIp: null,
      arkdLocalPort,
      sshPid,
      sshKeyPath: privateKeyPath,
      region,
      awsProfile: cfg.awsProfile,
      stackName: result.stack_name,
      sgId: result.sg_id,
      keyName: result.key_name,
      size,
      arch,
    };

    return {
      kind: this.kind,
      name,
      meta: { ec2: meta },
    };
  }

  // ── start / stop ─────────────────────────────────────────────────────────

  async start(h: ComputeHandle): Promise<void> {
    const meta = readMeta(h);
    const { publicIp, privateIp } = await this.helpers.startInstance({
      instanceId: meta.instanceId,
      region: meta.region,
      awsProfile: meta.awsProfile,
    });
    const ip = publicIp ?? privateIp;
    if (!ip) {
      throw new Error(`EC2Compute.start: instance ${meta.instanceId} has no IP after start`);
    }

    // Kill any previous tunnel (defensive -- stop() should have handled it,
    // but a crash/reboot may have left a stale PID on the meta).
    if (meta.sshPid !== null && meta.sshPid > 0) {
      this.helpers.killSshTunnel(meta.sshPid);
    }

    const sshPid = this.helpers.openSshTunnel({
      keyPath: meta.sshKeyPath,
      ip,
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
    // refreshed IP / tunnel PID. The DB-backed handle store in Wave 3
    // dispatch will persist this via a separate path.
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

  // ── snapshot / restore (Phase 3) ─────────────────────────────────────────

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
