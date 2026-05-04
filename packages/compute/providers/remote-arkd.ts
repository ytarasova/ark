/**
 * Remote compute providers - all 4 isolation modes running on EC2.
 *
 * Each extends ArkdBackedProvider and talks to arkd on the remote instance.
 * EC2 provisioning, SSM setup, and cloud-init are shared via RemoteArkdBase.
 * After provisioning, all operations go through ArkdClient - no more pool/queue.
 *
 * Isolation is encoded in how the launcher script is structured + what
 * extra setup is done during provision (docker install, firecracker, etc.).
 */

import { ArkdBackedProvider } from "./arkd-backed.js";
import { safeAsync } from "../../core/safe.js";
import { EC2PlacementCtx } from "./ec2/placement-ctx.js";
import type { Compute, Session, ProvisionOpts, SyncOpts, IsolationMode, LaunchOpts } from "../types.js";
import type { PlacementCtx } from "../../core/secrets/placement-types.js";
import { DeferredPlacementCtx } from "../../core/secrets/deferred-placement-ctx.js";
import { DEFAULT_CONDUCTOR_URL, DEFAULT_ARKD_PORT } from "../../core/constants.js";
import { logDebug, logError, logInfo } from "../../core/observability/structured-log.js";

const ARKD_REMOTE_PORT = DEFAULT_ARKD_PORT;
const REMOTE_USER = "ubuntu";
const REMOTE_HOME = `/home/${REMOTE_USER}`;

interface RemoteConfig {
  size?: string;
  arch?: string;
  region?: string;
  aws_profile?: string;
  subnet_id?: string;
  sg_id?: string;
  instance_id?: string;
  ip?: string;
  stack_name?: string;
  hourlyRate?: number;
  cloud_init_done?: boolean;
  idle_minutes?: number;
  ingress_cidrs?: string[];
  tags?: Record<string, string>;
  arkd_url?: string;
  /**
   * Conductor URL baked into cloud-init for arkd to call back to. From
   * inside the EC2 instance, the legacy `localhost:19100` default points
   * at the EC2 loopback (the conductor is on the operator's laptop), not
   * the conductor -- so any callback over that URL is silently misrouted.
   * Set this on the compute row when arkd needs a real callback path
   * (e.g. legacy in-VPC dispatch where there's no SSM port-forward
   * tunnelling /events back). The pure-SSM dispatch model preferred by
   * the conductor doesn't need this set: arkd serves WebSocket events
   * over the same forward tunnel and never initiates a callback.
   */
  conductor_url?: string;
  /**
   * Local port on the conductor where the SSM port-forward is listening,
   * tunneling to remote `localhost:19300`. Set by
   * `EC2Compute.setupTransport` after the forward is established; read by
   * `getArkdUrl` so `ArkdClient` reaches arkd via the local forward
   * instead of trying to hit the (private, unroutable) instance IP directly.
   */
  arkd_local_forward_port?: number;
  /**
   * Override the ArkdClient request timeout (ms). Default 30s is right for
   * health/launch/file ops; bump it for compute targets that legitimately
   * sit behind slow links so transient latency doesn't masquerade as a
   * dispatch-time hang. Lower it for control-plane-style deployments where
   * a fast fail is preferred.
   */
  arkd_request_timeout_ms?: number;
  isolation?: string;
  container_name?: string;
  devcontainer_workdir?: string;
  image?: string;
  last_error?: string;
}

// ── Shared remote base ──────────────────────────────────────────────────────

/**
 * Resolve the conductor URL baked into cloud-init for an EC2 provision.
 * Pure: no I/O. Exported for unit-testing F4 (audit finding) -- making sure
 * an operator-supplied `cfg.conductor_url` wins over the
 * `localhost:19100` default that arkd would otherwise see as its own
 * loopback.
 */
export function resolveProvisionConductorUrl(cfg: { conductor_url?: string }): string {
  return cfg.conductor_url ?? DEFAULT_CONDUCTOR_URL;
}

abstract class RemoteArkdBase extends ArkdBackedProvider {
  readonly singleton = false;
  readonly canReboot = true;
  readonly canDelete = true;
  readonly supportsWorktree = false;
  readonly initialStatus = "stopped";
  readonly needsAuth = true;

  /** Subclass isolation type label for cloud-init extras. */
  abstract readonly isolationType: string;

  getArkdUrl(compute: Compute, session?: Session): string {
    // Session-aware lookup (#423): when a session is in scope, the ONLY
    // acceptable source is `session.config.arkd_local_forward_port`, which
    // EC2Compute.setupTransport writes after the session's SSM tunnel is up.
    // No fallbacks: a session-bearing call without the per-session port is
    // a hard bug -- ensureReachable was skipped, or the conductor is trying
    // to talk to arkd before the tunnel was provisioned. Surfacing the error
    // is the only way to keep concurrent sessions from stomping each other.
    if (session) {
      const sessionPort = (session.config as { arkd_local_forward_port?: number } | null | undefined)
        ?.arkd_local_forward_port;
      if (!sessionPort) {
        throw new Error(
          `Session '${session.id}' has no arkd_local_forward_port; ensureReachable must run before any arkd RPC.`,
        );
      }
      return `http://localhost:${sessionPort}`;
    }

    // Compute-level lookup (no session). Used for provision-time health
    // probes and the per-compute events consumer. The per-compute port
    // here is "the latest tunnel that came up for this compute" -- it can
    // become stale, but no session is depending on it for correctness.
    const cfg = compute.config as RemoteConfig;
    if (cfg.arkd_local_forward_port) return `http://localhost:${cfg.arkd_local_forward_port}`;
    if (cfg.arkd_url) return cfg.arkd_url;
    if (cfg.ip) return `http://${cfg.ip}:${ARKD_REMOTE_PORT}`;
    throw new Error(`Compute '${compute.name}' has no arkd_local_forward_port, arkd_url, or ip`);
  }

  // ── Transport setup ────────────────────────────────────────────────────
  //
  // Forward-tunnel + arkd /health + events-consumer-start used to live in
  // an interim `prepareForLaunch` hook on this class. The same logic now
  // lives on `EC2Compute.setupTransport` (called via `Compute.ensureReachable`
  // from `runTargetLifecycle`); legacy provider rows still bridge through
  // `packages/compute/adapters/legacy.ts -> ComputeTarget(EC2Compute, ...)`.

  protected getArkdRequestTimeoutMs(compute: Compute): number | undefined {
    const cfg = compute.config as RemoteConfig;
    return typeof cfg.arkd_request_timeout_ms === "number" ? cfg.arkd_request_timeout_ms : undefined;
  }

  /**
   * Build a DeferredPlacementCtx for the EC2 family. This runs pre-launch on
   * the dispatcher, where the medium (SSM session against the instance) is
   * *not* yet available: for a stopped/destroyed compute the instance_id is
   * only assigned during `provider.start` / `provider.provision` inside
   * `provider.launch`.
   *
   * The deferred ctx captures `setEnv` synchronously (so env-typed secrets
   * land in the launch env the dispatcher hands to executor.launch) and
   * queues every file / provisioner op. The provider's launch flow flushes
   * those queued ops onto a real EC2PlacementCtx via `flushDeferredPlacement`
   * once the IP is known.
   *
   * Pre-fix behaviour: this method built an EC2PlacementCtx directly and
   * threw `Compute '<name>' has no IP -- cannot build EC2 PlacementCtx` for
   * any session whose compute had not been provisioned at the time the
   * dispatcher ran. Live EC2 dispatch failed reliably.
   */
  async buildPlacementCtx(_session: Session, _compute: Compute): Promise<PlacementCtx> {
    return new DeferredPlacementCtx(REMOTE_HOME);
  }

  /**
   * Flush a DeferredPlacementCtx onto a real EC2PlacementCtx. Called by every
   * subclass at the top of `launch()` -- after `Compute.ensureReachable` (run
   * by `runTargetLifecycle` for live ComputeTarget dispatch, or invoked
   * indirectly via the legacy adapter) has guaranteed the compute is started
   * + reachable, and before the agent process is spawned.
   *
   * Behaviour:
   *   - No-op when no deferred ctx was attached (e.g. a session with only
   *     env-typed secrets, or a session where the dispatcher's placement
   *     branch was disabled).
   *   - No-op when the deferred ctx has no queued file ops (only env was
   *     set) -- nothing to flush, regardless of whether the compute has an
   *     instance_id.
   *   - THROWS when the ctx has queued file/provisioner ops but the compute
   *     config still lacks an instance_id. Pre-fix this only logged a warning
   *     and dropped the queued ops on the floor, leading to silent failures
   *     where the agent ran without its SSH key / kubeconfig / generic blob
   *     and `dispatch_failed` was never reported. The throw propagates up
   *     through `provider.launch -> executor.launch -> dispatch-core` so
   *     `kickDispatch` marks the dispatch failed and the user sees it.
   */
  protected async flushDeferredPlacement(compute: Compute, opts: LaunchOpts): Promise<void> {
    const deferred = opts.placement;
    if (!(deferred instanceof DeferredPlacementCtx)) return;
    if (!deferred.hasDeferred()) {
      logDebug("compute", `flushDeferredPlacement: no queued ops on '${compute.name}', skipping`);
      return;
    }
    const cfg = compute.config as RemoteConfig;
    if (!cfg.instance_id) {
      // Fail-fast: dropping queued file-typed secret ops here used to leave
      // the agent running without its SSH key / kubeconfig and surface no
      // terminal status. Keep the queued count in the message so the user
      // can correlate against `secrets list`.
      throw new Error(
        `flushDeferredPlacement: compute '${compute.name}' has no instance_id at launch time but ` +
          `${deferred.queuedOps.length} placement op(s) are queued. Cannot proceed.`,
      );
    }
    const realCtx = new EC2PlacementCtx({
      instanceId: cfg.instance_id,
      region: cfg.region ?? "us-east-1",
      awsProfile: cfg.aws_profile,
    });
    logInfo(
      "compute",
      `[trace:flushDeferred] compute=${compute.name} instanceId=${cfg.instance_id} ops=${deferred.queuedOps.length}`,
    );
    await deferred.flush(realCtx);
    logInfo("compute", `[trace:flushDeferred] done compute=${compute.name}`);
  }

  async provision(compute: Compute, opts?: ProvisionOpts): Promise<void> {
    const log = opts?.onLog ?? (() => {});
    const cfg = compute.config as RemoteConfig;
    this.app.computes.update(compute.name, { status: "provisioning" });

    try {
      const { provisionStack, resolveInstanceType } = await import("./ec2/provision.js");
      const { hourlyRate } = await import("./ec2/cost.js");
      const { poll } = await import("../util.js");

      log("Building cloud-init script with arkd...");
      // Prefer per-compute `cfg.conductor_url` over the package-level
      // DEFAULT_CONDUCTOR_URL fallback. DEFAULT_CONDUCTOR_URL hardcodes
      // `http://localhost:19100`, which from inside an EC2 instance
      // resolves to the instance's loopback -- not the operator's
      // conductor. That worked when SSH had a -R reverse tunnel; it
      // breaks under the SSM-only model, where the conductor is
      // unreachable from the instance unless explicitly threaded
      // through. For the pure-SSM dispatch model the operator can
      // leave this unset and arkd serves WebSocket events over the
      // forward tunnel rather than initiating a callback. Audit
      // finding F4. Mirrors the pattern `EC2Compute.provision` already
      // uses (`cfg.conductorUrl` -> buildUserData).
      const conductorUrl = resolveProvisionConductorUrl(cfg);
      const userData = await buildUserDataWithArkd({
        idleMinutes: cfg.idle_minutes ?? 60,
        isolation: this.isolationType,
        conductorUrl,
      });

      log("Provisioning EC2 instance...");
      const result = await provisionStack(compute.name, {
        size: opts?.size ?? cfg.size ?? "m",
        arch: opts?.arch ?? cfg.arch ?? "x64",
        region: cfg.region ?? "us-east-1",
        subnetId: cfg.subnet_id,
        securityGroupId: cfg.sg_id,
        awsProfile: cfg.aws_profile,
        userData,
        tags: opts?.tags ?? cfg.tags,
        onOutput: (msg) => {
          if (msg.includes("creating") || msg.includes("created") || msg.includes("updated")) {
            log(msg.slice(0, 120));
          }
        },
      });

      log(`Instance ${result.instance_id} launched (IP: ${result.ip ?? "pending"})`);
      this.app.computes.update(compute.name, { status: "running" });
      this.app.computes.mergeConfig(compute.name, {
        ...(result as unknown as Record<string, unknown>),
        arkd_url: `http://${result.ip}:${ARKD_REMOTE_PORT}`,
      });

      // Store hourly rate
      const instanceType = resolveInstanceType(opts?.size ?? cfg.size ?? "m", opts?.arch ?? cfg.arch ?? "x64");
      const rate = hourlyRate(instanceType);
      if (rate > 0) this.app.computes.mergeConfig(compute.name, { hourlyRate: rate });

      // Wait for SSM agent + cloud-init. With pure SSM, connectivity is
      // gated on DescribeInstanceInformation reporting "Online".
      if (result.instance_id) {
        const region = cfg.region ?? "us-east-1";
        const awsProfile = cfg.aws_profile;
        const { ssmExec, ssmCheckInstance } = await import("./ec2/ssm.js");
        log("Waiting for SSM agent online...");
        await poll(() => ssmCheckInstance({ instanceId: result.instance_id, region, awsProfile }), {
          maxAttempts: 30,
          delayMs: 5000,
        });

        log("Waiting for cloud-init to finish...");
        await poll(
          async () => {
            const res = await ssmExec({
              instanceId: result.instance_id,
              region,
              awsProfile,
              command: `test -f ${REMOTE_HOME}/.ark-ready && echo ready`,
              timeoutMs: 10_000,
            });
            return res.stdout.includes("ready");
          },
          { maxAttempts: 60, delayMs: 10_000 },
        );

        // Wait for arkd to be reachable. We poll via SSM SendCommand
        // (curl localhost:ARKD_REMOTE_PORT) on the instance: the conductor
        // network can't reach arkd directly until the port-forward is up.
        log("Waiting for arkd...");
        await poll(
          async () => {
            const res = await ssmExec({
              instanceId: result.instance_id,
              region,
              awsProfile,
              command: `curl -fsS http://localhost:${ARKD_REMOTE_PORT}/health`,
              timeoutMs: 10_000,
            });
            return res.exitCode === 0;
          },
          { maxAttempts: 30, delayMs: 3000 },
        );

        log("arkd is online.");

        // Post-provision isolation setup
        await this.postProvision(compute, log);
      }

      this.app.computes.mergeConfig(compute.name, { cloud_init_done: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.app.computes.mergeConfig(compute.name, { last_error: reason });
      this.app.computes.update(compute.name, { status: "stopped" });
      // Pre-fix the failure was only readable via `compute show` (the
      // last_error field). No event row, no operator-tailable signal in
      // ~/.ark/ark.jsonl. Add a structured logError so a provision failure
      // is visible alongside the rest of the system's structured events;
      // the existing throw still surfaces through the caller's normal
      // error path.
      logError("compute", `provision failed for compute '${compute.name}': ${reason}`, {
        compute: compute.name,
        provider: this.constructor.name,
        error: reason,
      });
      throw err;
    }
  }

  /** Override in subclasses for isolation-specific post-provision setup. */
  async postProvision(_compute: Compute, _log: (msg: string) => void): Promise<void> {}

  async destroy(compute: Compute): Promise<void> {
    const { destroyStack } = await import("./ec2/provision.js");
    const { destroyPool } = await import("./ec2/pool.js");
    const { teardownForwardTunnel } = await import("./ec2/ports.js");
    const { stopArkdEventsConsumer } = await import("../../core/conductor/arkd-events-consumer.js");

    const cfg = compute.config as RemoteConfig;
    if (cfg.instance_id) {
      // Stop pulling events from this compute's arkd before tearing down
      // the forward tunnel that carries the stream.
      stopArkdEventsConsumer(compute.name);
      // Tear down the arkd forward tunnel established by
      // `EC2Compute.setupTransport`. We key off (instance_id,
      // ARKD_REMOTE_PORT) -- the local port is dynamically allocated and
      // may or may not be in the config (it gets cleared below).
      await safeAsync(`[remote] destroy: teardown arkd forward tunnel for ${compute.name}`, async () => {
        await teardownForwardTunnel(cfg.instance_id!, ARKD_REMOTE_PORT);
      });
      // Clear the persisted local-forward port so a future re-provision
      // doesn't try to reuse a port that no longer points anywhere.
      await safeAsync(`[remote] destroy: clear arkd_local_forward_port for ${compute.name}`, async () => {
        await this.app.computes.mergeConfig(compute.name, { arkd_local_forward_port: undefined });
      });
    }

    // Pass the resource IDs we stashed at provision time. Without these,
    // destroyStack's three branches (TerminateInstances / DeleteSecurityGroup
    // / DeleteKeyPair) all silently no-op -- the function returns success
    // without making any AWS API calls and the instance keeps billing.
    // Reproduced earlier this session: yt-ec2 reported "Compute 'yt-ec2'
    // destroyed" but `aws ec2 describe-instances` showed `running`.
    await safeAsync(`[remote] destroy: ${compute.name}`, async () => {
      await destroyStack(compute.name, {
        region: cfg.region,
        awsProfile: cfg.aws_profile,
        instance_id: cfg.instance_id,
        sg_id: cfg.sg_id,
      });
      destroyPool(compute.name);
    });
    this.app.computes.update(compute.name, { status: "destroyed" });
  }

  async start(compute: Compute): Promise<void> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.instance_id) throw new Error("No instance_id - cannot start");

    const region = cfg.region ?? "us-east-1";
    const awsProfile = cfg.aws_profile;
    const { EC2Client, StartInstancesCommand, DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
    const { awsCredentialsForProfile } = await import("./ec2/aws-creds.js");
    const { poll } = await import("../util.js");

    const ec2 = new EC2Client({
      region,
      credentials: awsCredentialsForProfile({ profile: awsProfile }),
    });

    await ec2.send(new StartInstancesCommand({ InstanceIds: [cfg.instance_id] }));

    // Poll until the instance has reached the "running" state. With SSM
    // transport we don't depend on a public IP; we still record any private
    // IP we see for legacy callers + diagnostic logs.
    let privateIp: string | null = null;
    await poll(
      async () => {
        const desc = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [cfg.instance_id!] }));
        const inst = desc.Reservations?.[0]?.Instances?.[0];
        privateIp = inst?.PrivateIpAddress ?? null;
        return inst?.State?.Name === "running";
      },
      { maxAttempts: 30, delayMs: 5000 },
    );

    this.app.computes.mergeConfig(compute.name, {
      ...(privateIp ? { ip: privateIp } : {}),
    });

    // Wait for arkd by curling its loopback endpoint over SSM SendCommand.
    // Avoids depending on conductor->instance HTTP reachability.
    const { ssmExec } = await import("./ec2/ssm.js");
    await poll(
      async () => {
        const res = await ssmExec({
          instanceId: cfg.instance_id!,
          region,
          awsProfile,
          command: `curl -fsS http://localhost:${ARKD_REMOTE_PORT}/health`,
          timeoutMs: 10_000,
        });
        return res.exitCode === 0;
      },
      { maxAttempts: 30, delayMs: 2000 },
    );

    this.app.computes.update(compute.name, { status: "running" });
  }

  async stop(compute: Compute): Promise<void> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.instance_id) throw new Error("No instance_id - cannot stop");

    // Tear down the arkd-forward tunnel before the EC2 stop -- the AWS CLI
    // process is local; killing it after the instance halts only delays
    // cleanup. The pgrep pattern matches the SSM start-session command for
    // the target instance_id. Also stops the events-stream consumer that
    // rides over this tunnel.
    if (cfg.instance_id) {
      const { teardownForwardTunnel } = await import("./ec2/ports.js");
      const { stopArkdEventsConsumer } = await import("../../core/conductor/arkd-events-consumer.js");
      stopArkdEventsConsumer(compute.name);
      await safeAsync(`[remote] stop: teardown arkd forward tunnel for ${compute.name}`, async () => {
        await teardownForwardTunnel(cfg.instance_id!, ARKD_REMOTE_PORT);
      });
      // Clear the local-forward port -- on next start,
      // `EC2Compute.setupTransport` will allocate a fresh one (the previous
      // local port may be reused by unrelated processes while we're stopped).
      await safeAsync(`[remote] stop: clear arkd_local_forward_port for ${compute.name}`, async () => {
        await this.app.computes.mergeConfig(compute.name, { arkd_local_forward_port: undefined });
      });
    }

    const { EC2Client, StopInstancesCommand } = await import("@aws-sdk/client-ec2");
    const { awsCredentialsForProfile } = await import("./ec2/aws-creds.js");

    const ec2 = new EC2Client({
      region: cfg.region ?? "us-east-1",
      credentials: awsCredentialsForProfile({ profile: cfg.aws_profile }),
    });

    await ec2.send(new StopInstancesCommand({ InstanceIds: [cfg.instance_id] }));
    this.app.computes.update(compute.name, { status: "stopped" });
  }

  async attach(_compute: Compute, _session: Session): Promise<void> {
    // Attach handled by CLI with SSH + tmux
  }

  async syncEnvironment(compute: Compute, opts: SyncOpts): Promise<void> {
    const cfg = compute.config as RemoteConfig;
    if (!cfg.instance_id) return;
    const { syncToHost } = await import("./ec2/sync.js");
    await syncToHost(cfg.instance_id, {
      direction: opts.direction,
      categories: opts.categories,
      region: cfg.region ?? "us-east-1",
      awsProfile: cfg.aws_profile,
      onLog: opts.onLog,
    });
  }

  getAttachCommand(compute: Compute, session: Session): string[] {
    const cfg = compute.config as RemoteConfig;
    if (!session.session_id || !cfg.instance_id) return [];
    const region = cfg.region ?? "us-east-1";
    const args = [
      "aws",
      "ssm",
      "start-session",
      "--target",
      cfg.instance_id,
      "--document-name",
      "AWS-StartInteractiveCommand",
      "--parameters",
      `command=["tmux attach -t ${session.session_id}"]`,
      "--region",
      region,
    ];
    if (cfg.aws_profile) args.push("--profile", cfg.aws_profile);
    return args;
  }

  buildChannelConfig(
    sessionId: string,
    stage: string,
    channelPort: number,
    opts?: { conductorUrl?: string },
  ): Record<string, unknown> {
    return {
      command: `${REMOTE_HOME}/.ark/bin/ark`,
      args: ["channel"],
      env: {
        ARK_SESSION_ID: sessionId,
        ARK_STAGE: stage,
        ARK_CHANNEL_PORT: String(channelPort),
        ARK_CONDUCTOR_URL: opts?.conductorUrl ?? DEFAULT_CONDUCTOR_URL,
        ARK_ARKD_URL: `http://localhost:${ARKD_REMOTE_PORT}`, // always localhost on the remote host
      },
    };
  }

  buildLaunchEnv(_session: Session): Record<string, string> {
    const env: Record<string, string> = {};
    // Forward Claude auth tokens if present
    for (const key of ["CLAUDE_CODE_API_KEY", "ANTHROPIC_API_KEY"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    return env;
  }

  async cleanupSession(compute: Compute, session: Session): Promise<void> {
    // `session.workdir` is the conductor's local-filesystem path (e.g.
    // `/Users/paytmlabs/Projects/ark`). `rm -rf` of that path on EC2 is at
    // best a silent no-op (path doesn't exist on Ubuntu) and at worst could
    // delete the wrong tree if a future build path happens to collide. We
    // need the *remote* workdir, which `RemoteWorktreeProvider.resolveWorkdir`
    // computes as `${REMOTE_HOME}/Projects/<sessionId>/<repoBasename>`.
    //
    // Subclasses that don't expose a workdir (RemoteDocker, RemoteFirecracker)
    // either use a container-internal path or no workdir at all, and they
    // override cleanupSession or override resolveWorkdir explicitly. For
    // those, resolveWorkdir returns null and we skip the rm rather than
    // guessing -- skipping leaks at most a directory until the EC2 instance
    // cycles, while a wrong rm is destructive.
    const remoteWorkdir = this.resolveWorkdir?.(compute, session) ?? null;
    if (!remoteWorkdir) {
      logDebug(
        "compute",
        `[remote] cleanupSession: no remote workdir resolved for ${session.id} on ${compute.name}; skipping rm`,
      );
      return;
    }
    // Defensive: NEVER rm a conductor-shaped path. macOS conductors live
    // under /Users/...; Linux conductors under /home/<user> -- but the
    // remote here is always an EC2 ubuntu host, so the only valid prefixes
    // for cleanup are /home/ubuntu/ (REMOTE_HOME) and /workspace/. Bail out
    // loudly on anything else so a future regression in resolveWorkdir
    // can't turn this back into a footgun.
    if (!remoteWorkdir.startsWith(`${REMOTE_HOME}/`) && !remoteWorkdir.startsWith("/workspace/")) {
      logError(
        "compute",
        `[remote] cleanupSession: refusing to rm '${remoteWorkdir}' on ${compute.name} -- not a remote-safe path`,
        { compute: compute.name, session: session.id, path: remoteWorkdir },
      );
      return;
    }
    const client = this.getClient(compute);
    await safeAsync(`[remote] cleanupSession: rm workdir for ${session.id} on ${compute.name}`, async () => {
      await client.run({ command: "rm", args: ["-rf", remoteWorkdir] });
    });
  }

  /**
   * Subclasses MAY implement this to translate the conductor-side workdir
   * path to the remote host. Default returns null (caller skips path-scoped
   * cleanup). Mirrors `Compute.resolveWorkdir`.
   */
  resolveWorkdir?(_compute: Compute, _session: Session): string | null;
}

// ── Remote Worktree Provider (was "ec2") ────────────────────────────────────

export class RemoteWorktreeProvider extends RemoteArkdBase {
  readonly name = "ec2";
  readonly isolationType = "worktree";
  readonly isolationModes: IsolationMode[] = [{ value: "inplace", label: "Remote checkout (in-place)" }];

  /**
   * Pick the URL/path EC2 should clone from. `session.repo` is the local-
   * filesystem path on the conductor (e.g. /Users/yana/Projects/ark) which
   * doesn't exist on EC2; `session.config.remoteRepo` is the URL the user
   * passed via `--remote-repo` and is the source of truth for remote clones.
   * Prefer the remote URL; fall back to session.repo only when the conductor
   * and the compute target share a filesystem (not the case for EC2 today,
   * but keeps the contract honest for future co-located compute kinds).
   */
  private cloneSource(session: Session): string | null {
    const cfg = session.config as { remoteRepo?: string } | null | undefined;
    if (cfg?.remoteRepo) return cfg.remoteRepo;
    if (session.repo) return session.repo;
    return null;
  }

  /** Repo basename used to derive the workdir path under ${REMOTE_HOME}/Projects. */
  private repoBasename(session: Session): string {
    const src = this.cloneSource(session);
    if (!src) return "project";
    return (
      src
        .split("/")
        .pop()
        ?.replace(/\.git$/, "") ?? "project"
    );
  }

  /**
   * Where the cloned worktree lives on the remote host. The executor reads
   * this via the optional `provider.resolveWorkdir(...)` hook to (a) embed
   * the right path in the launcher's `cd` and (b) target the right path in
   * the heredocs that write `.mcp.json` / `.claude/settings.local.json` on
   * the remote. Without this, the launcher gets the conductor's local
   * workdir which doesn't exist on Ubuntu.
   */
  resolveWorkdir(_compute: Compute, session: Session): string | null {
    if (!this.cloneSource(session)) return null;
    // Session-scoped path so concurrent / sequential sessions on the same
    // compute don't collide: each session clones into its own directory
    // and we never inherit a half-populated clone from a crashed run.
    // Repo basename stays in the path for human readability.
    return `${REMOTE_HOME}/Projects/${session.id}/${this.repoBasename(session)}`;
  }

  async launch(_compute: Compute, _session: Session, _opts: LaunchOpts): Promise<string> {
    // Deprecated: live dispatch routes through `ComputeTarget(EC2Compute,
    // DirectIsolation)` via `runTargetLifecycle`. Legacy callers that still
    // hold a RemoteWorktreeProvider can map to the new target through
    // `packages/compute/adapters/legacy.ts:computeProviderToTarget`.
    throw new Error(
      "RemoteWorktreeProvider.launch is deprecated; dispatch via ComputeTarget. " +
        "See packages/compute/adapters/legacy.ts.",
    );
  }
}

// ── Remote Docker Provider ──────────────────────────────────────────────────
//
// Will be superseded by `EC2Compute + DockerIsolation`. Today's sessions still
// dispatch through these classes for killAgent / cleanupSession / metrics --
// the new Compute interface doesn't cover those verbs yet, so the classes
// below stay registered at boot and remain the live path.

export class RemoteDockerProvider extends RemoteArkdBase {
  readonly name = "ec2-docker";
  readonly isolationType = "docker";
  readonly isolationModes: IsolationMode[] = [{ value: "container", label: "Docker container on EC2" }];

  private containerName(compute: Compute): string {
    return `ark-${compute.name}`;
  }

  async postProvision(compute: Compute, log: (msg: string) => void): Promise<void> {
    const client = this.getClient(compute);
    const cfg = compute.config as RemoteConfig;
    const image = cfg.image || "ubuntu:22.04";
    const container = this.containerName(compute);

    log(`Pulling Docker image ${image} on remote...`);
    await client.run({ command: "docker", args: ["pull", image], timeout: 300_000 });

    log("Creating Docker container...");
    await client.run({
      command: "docker",
      args: [
        "create",
        "--name",
        container,
        "-it",
        "-v",
        `${REMOTE_HOME}/.ssh:/root/.ssh:ro`,
        "-v",
        `${REMOTE_HOME}/.claude:/root/.claude:ro`,
        image,
        "bash",
      ],
    });
    await client.run({ command: "docker", args: ["start", container] });

    this.app.computes.mergeConfig(compute.name, { container_name: container });
    log("Remote Docker container ready.");
  }

  async launch(compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    // Replay deferred placement onto the EC2 host (host-level files; the
    // container bind-mounts ~/.ssh and ~/.claude, so placing on the host
    // is what the container picks up).
    await this.flushDeferredPlacement(compute, opts);

    const client = this.getClient(compute);
    const container = this.containerName(compute);

    const scriptPath = `/tmp/arkd-launcher-${opts.tmuxName}.sh`;
    await client.writeFile({ path: scriptPath, content: opts.launcherContent, mode: 0o755 });
    await client.run({ command: "docker", args: ["cp", scriptPath, `${container}:${scriptPath}`] });
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: `#!/bin/bash\ndocker exec -i ${container} bash ${scriptPath}`,
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }
}

// ── Remote Devcontainer Provider ────────────────────────────────────────────

export class RemoteDevcontainerProvider extends RemoteArkdBase {
  readonly name = "ec2-devcontainer";
  readonly isolationType = "devcontainer";
  readonly isolationModes: IsolationMode[] = [{ value: "devcontainer", label: "Devcontainer on EC2" }];

  async postProvision(compute: Compute, log: (msg: string) => void): Promise<void> {
    const client = this.getClient(compute);
    const cfg = compute.config as RemoteConfig;
    const workdir = cfg.devcontainer_workdir || `${REMOTE_HOME}/Projects/workspace`;

    // Clone repo if configured
    if (cfg.devcontainer_workdir) {
      log("Building devcontainer on remote...");
      await client.run({
        command: "devcontainer",
        args: ["up", "--workspace-folder", workdir],
        timeout: 300_000,
      });
    }

    this.app.computes.mergeConfig(compute.name, { devcontainer_workdir: workdir });
    log("Remote devcontainer ready.");
  }

  async launch(compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    await this.flushDeferredPlacement(compute, opts);

    const client = this.getClient(compute);
    const cfg = compute.config as RemoteConfig;
    const workdir = (cfg.devcontainer_workdir as string) || opts.workdir;

    const scriptPath = `/tmp/arkd-launcher-${opts.tmuxName}.sh`;
    await client.writeFile({ path: scriptPath, content: opts.launcherContent, mode: 0o755 });
    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: `#!/bin/bash\ndevcontainer exec --workspace-folder '${workdir}' -- bash ${scriptPath}`,
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }
}

// ── Remote Firecracker Provider ─────────────────────────────────────────────

export class RemoteFirecrackerProvider extends RemoteArkdBase {
  readonly name = "ec2-firecracker";
  readonly isolationType = "firecracker";
  readonly isolationModes: IsolationMode[] = [{ value: "microvm", label: "Firecracker microVM on EC2" }];

  async postProvision(compute: Compute, log: (msg: string) => void): Promise<void> {
    const client = this.getClient(compute);

    log("Installing Firecracker on remote...");
    // Download firecracker binary
    await client.run({
      command: "bash",
      args: [
        "-c",
        `
        ARCH=$(uname -m)
        RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases"
        LATEST=$(curl -fsSLI -o /dev/null -w %{url_effective} \${RELEASE_URL}/latest | grep -oE "[^/]+$")
        curl -L \${RELEASE_URL}/download/\${LATEST}/firecracker-\${LATEST}-\${ARCH}.tgz | tar -xz -C /tmp
        sudo mv /tmp/release-*/firecracker-\${LATEST}-\${ARCH} /usr/local/bin/firecracker
        sudo chmod +x /usr/local/bin/firecracker
      `,
      ],
      timeout: 120_000,
    });

    // Download a minimal kernel + rootfs (Ubuntu-based with bun)
    log("Downloading kernel and rootfs...");
    await client.run({
      command: "bash",
      args: [
        "-c",
        `
        sudo mkdir -p /opt/firecracker
        # Download pre-built kernel
        curl -fsSL -o /opt/firecracker/vmlinux \
          https://s3.amazonaws.com/spec.ccfc.min/img/quickstart_guide/x86_64/kernels/vmlinux.bin 2>/dev/null || true
      `,
      ],
      timeout: 120_000,
    });

    this.app.computes.mergeConfig(compute.name, {
      firecracker_installed: true,
      kernel_path: "/opt/firecracker/vmlinux",
    });
    log("Firecracker ready on remote.");
  }

  async launch(compute: Compute, _session: Session, opts: LaunchOpts): Promise<string> {
    await this.flushDeferredPlacement(compute, opts);

    const client = this.getClient(compute);
    const _cfg = compute.config as RemoteConfig;
    const vmSshPort = 2222; // Default firecracker VM SSH port

    const scriptPath = `/tmp/arkd-launcher-${opts.tmuxName}.sh`;
    await client.writeFile({ path: scriptPath, content: opts.launcherContent, mode: 0o755 });

    await client.launchAgent({
      sessionName: opts.tmuxName,
      script: [
        "#!/bin/bash",
        `scp -o StrictHostKeyChecking=no -P ${vmSshPort} ${scriptPath} root@localhost:${scriptPath}`,
        `ssh -o StrictHostKeyChecking=no -p ${vmSshPort} root@localhost bash ${scriptPath}`,
      ].join("\n"),
      workdir: opts.workdir,
    });
    return opts.tmuxName;
  }
}

// ── Cloud-init with arkd ────────────────────────────────────────────────────

async function buildUserDataWithArkd(opts: {
  idleMinutes?: number;
  isolation?: string;
  conductorUrl?: string;
}): Promise<string> {
  const { buildUserData } = await import("./ec2/cloud-init.js");
  let base = buildUserData(opts) as string;

  const conductorFlag = opts.conductorUrl ? ` --conductor-url ${opts.conductorUrl}` : "";

  // Insert arkd startup before the ready marker
  const arkdSetup = `
# ── ArkD daemon (universal agent API) ──────────────────────────────────────
cat > /etc/systemd/system/arkd.service <<UNIT
[Unit]
Description=ArkD Agent Daemon
After=network.target

[Service]
User=ubuntu
# install.sh (https://ytarasova.github.io/ark/install.sh) drops a Bun-compiled
# ELF at ~/.ark/bin/ark -- run it directly. The previous \`bun \${ark}\` prefix
# made bun parse the ELF as JS source and crash at :1:1, leaving systemd
# in an "activating (auto-restart)" loop and the post-provision arkd-health
# poll failing.
ExecStart=${REMOTE_HOME}/.ark/bin/ark arkd --port ${ARKD_REMOTE_PORT}${conductorFlag}
Restart=always
RestartSec=5
Environment=HOME=${REMOTE_HOME}

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable arkd
systemctl start arkd

# ── Open arkd port in iptables ─────────────────────────────────────────────
iptables -A INPUT -p tcp --dport ${ARKD_REMOTE_PORT} -j ACCEPT || true
`;

  // Insert before the ready marker
  base = base.replace("# ── Ready marker", `${arkdSetup}\n# ── Ready marker`);

  return base;
}
