/**
 * Remote-environment preparation helpers shared by the claude-code executor.
 *
 * Extracted from session-orchestration.ts. The executor calls
 * `prepareRemoteEnvironment` to build the launcher content for remote
 * compute targets; the applyContainerSetup helper wraps it with Docker
 * Compose / devcontainer logic.
 */

import type { AppContext } from "../app.js";
import type { Session, Compute } from "../../types/index.js";
import type { ComputeProvider } from "../../compute/types.js";
import { resolvePortDecls, parseArcJson } from "../../compute/arc-json.js";
import { allocatePort } from "../config/port-allocator.js";
import { DEFAULT_ARKD_PORT } from "../constants.js";
import { logError } from "../observability/structured-log.js";

/** Apply arc.json container setup: Docker Compose and devcontainer. */
async function applyContainerSetup(
  compute: Compute,
  effectiveWorkdir: string,
  launchContent: string,
  onLog: (msg: string) => void,
): Promise<string> {
  if (!effectiveWorkdir) return launchContent;

  // Docker Compose - only when explicitly enabled in arc.json { "compose": true }
  const arcJson = parseArcJson(effectiveWorkdir);
  const cfg = compute.config as { instance_id?: string; region?: string; aws_profile?: string } | null | undefined;
  if (arcJson?.compose === true && cfg?.instance_id) {
    onLog("Starting Docker Compose services...");
    const { sshExec, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
    const { shellEscape } = await import("../../compute/providers/ec2/shell-escape.js");
    // `effectiveWorkdir` is a DB-persisted value derived (transitively) from
    // session.workdir / session.repo, both attacker-controllable in hosted
    // mode. Escape before interpolating into the remote shell.
    const quotedWorkdir = shellEscape(effectiveWorkdir);
    sshExec(sshKeyPath(compute.name), cfg.instance_id, `cd ${quotedWorkdir} && docker compose up -d`, {
      region: cfg.region ?? "us-east-1",
      awsProfile: cfg.aws_profile,
    });
  }

  // Devcontainer - only used when explicitly enabled in arc.json { "devcontainer": true }
  if (arcJson?.devcontainer === true) {
    onLog("Building devcontainer...");
    const { buildLaunchCommand } = await import("../../compute/providers/docker/devcontainer.js");
    return buildLaunchCommand(effectiveWorkdir, launchContent);
  }

  return launchContent;
}

/** Prepare remote compute: connectivity check, env sync, docker/devcontainer setup. */
export async function prepareRemoteEnvironment(
  app: AppContext,
  session: Session,
  compute: Compute,
  provider: ComputeProvider,
  effectiveWorkdir: string,
  opts?: { launchContent?: string; onLog?: (msg: string) => void },
): Promise<{ finalLaunchContent: string; ports: any[] }> {
  const log = opts?.onLog ?? (() => {});

  // Auto-start stopped computes
  if (compute.status === "stopped") {
    log(`Starting compute '${compute.name}'...`);
    await provider.start(compute);
  }

  // Verify host is reachable before starting expensive sync/clone chain.
  // SSM transport keys off instance_id; no IP required.
  const cfgRemote = compute.config as { instance_id?: string; region?: string; aws_profile?: string };
  const instanceId = cfgRemote.instance_id;
  if (instanceId) {
    const region = cfgRemote.region ?? "us-east-1";
    const awsProfile = cfgRemote.aws_profile;
    log("Checking host connectivity (via SSM)...");
    const { sshExecAsync, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
    const { exitCode } = await sshExecAsync(sshKeyPath(compute.name), instanceId, "echo ok", {
      timeout: 15_000,
      region,
      awsProfile,
    });
    if (exitCode !== 0) {
      throw new Error(`Cannot reach compute '${compute.name}' at ${instanceId} (via SSM)`);
    }

    // Reverse tunnel back to the conductor. Required for normal operation:
    // the agent's ark hooks (curl to ${conductorUrl}/hooks/status) and the
    // ark-channel MCP server (ARK_CONDUCTOR_URL) both speak HTTP back to the
    // conductor over `localhost:<conductorPort>`. From EC2 that's the
    // instance's own loopback unless we tunnel; with the tunnel up (over SSM),
    // EC2 -> SSH -> conductor's localhost:<conductorPort>. Idempotent: if a
    // tunnel for this (instance_id, port) already exists we reuse it.
    const conductorPort = app.config.ports.conductor;
    const { setupReverseTunnel, setupForwardTunnel } = await import("../../compute/providers/ec2/ports.js");
    const tunnel = await setupReverseTunnel(sshKeyPath(compute.name), instanceId, conductorPort, {
      region,
      awsProfile,
    });
    if (tunnel.pid) {
      log(
        `Reverse tunnel ${tunnel.reused ? "reused" : "established"} (pid ${tunnel.pid}) ` +
          `localhost:${conductorPort} on ${compute.name} -> conductor`,
      );
    } else {
      log(`WARNING: reverse tunnel did not register a PID -- hooks/channel may be unreachable`);
    }

    // Forward tunnel for arkd. After we dropped public-IP assignment (commit
    // 7a888f74), `cfg.ip` is the *private* address (e.g. 10.x.y.z). The
    // conductor (running on the operator's laptop) can't reach a private
    // VPC IP, so every ArkdClient call (`launch`, `killAgent`, `captureOutput`,
    // `checkSession`, `getMetrics`, `probePorts`, plus the worktree
    // provider's `git clone`) hung until 30s timeout. Wire an SSH `-L`
    // forward tunnel over SSM so `ArkdClient` reaches arkd via
    // `http://localhost:<localForwardPort>`. The local port is allocated
    // dynamically per compute and persisted on `compute.config.arkd_local_forward_port`
    // for `RemoteArkdBase.getArkdUrl` to read.
    const localPort = await allocatePort();
    const arkdTunnel = await setupForwardTunnel(sshKeyPath(compute.name), instanceId, DEFAULT_ARKD_PORT, localPort, {
      region,
      awsProfile,
    });
    if (!arkdTunnel.pid) {
      throw new Error(
        `Failed to set up arkd forward tunnel for compute '${compute.name}' ` +
          `(localhost:${arkdTunnel.localPort} -> ${instanceId}:${DEFAULT_ARKD_PORT})`,
      );
    }
    log(
      `Arkd forward tunnel ${arkdTunnel.reused ? "reused" : "established"} (pid ${arkdTunnel.pid}) ` +
        `localhost:${arkdTunnel.localPort} -> ${instanceId}:${DEFAULT_ARKD_PORT}`,
    );
    // Persist the local-forward port so getArkdUrl resolves to the tunneled
    // localhost endpoint instead of the unreachable private IP. Reuse case
    // covers crashed-conductor restarts: the SSH process is still alive and
    // we round-trip its actual local port from `ps`.
    await app.computes.mergeConfig(compute.name, { arkd_local_forward_port: arkdTunnel.localPort });
  }

  // Resolve ports from arc.json / devcontainer / compose
  const ports = effectiveWorkdir ? resolvePortDecls(effectiveWorkdir) : [];

  // Store ports on session config
  if (ports.length > 0) {
    await app.sessions.update(session.id, {
      config: { ...session.config, ports },
    });
  }

  // Sync environment to compute
  log("Syncing credentials...");
  try {
    const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
    await provider.syncEnvironment(compute, {
      direction: "push",
      projectFiles: arcJson?.sync,
      projectDir: effectiveWorkdir,
      onLog: log,
    });
  } catch (e: any) {
    // The session-scoped `log` callback writes to a per-launch stream that's
    // invisible in stuck-at-ready debugging scenarios. logError lands in
    // ~/.ark/ark.jsonl so operators tailing structured logs see the failure.
    // We still continue (sync is best-effort -- the agent might have what it
    // needs from the remote's existing env), but the failure is no longer
    // silent.
    //
    // TODO: classify failures (auth-required, network-blip, partial-sync,
    // permission-denied) and short-circuit to dispatch_failed for the
    // un-recoverable cases. Tracked as Phase 3 polish.
    const reason = e?.message ?? String(e);
    log(`Credential sync failed (continuing): ${reason}`);
    logError(
      "session",
      `prepareRemoteEnvironment: syncEnvironment failed (compute=${compute.name}, sessionId=${session.id})`,
      { sessionId: session.id, compute: compute.name, error: reason },
    );
  }

  // Apply container setup (Docker Compose + devcontainer)
  const finalLaunchContent = await applyContainerSetup(compute, effectiveWorkdir, opts?.launchContent ?? "", log);

  return { finalLaunchContent, ports };
}
