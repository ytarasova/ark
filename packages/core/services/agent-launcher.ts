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
import { logInfo } from "../observability/structured-log.js";

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
  const sid = session.id;
  logInfo("session", `[trace:prep:${sid}] start compute=${compute.name} status=${compute.status}`);

  // Auto-start stopped computes
  if (compute.status === "stopped") {
    log(`Starting compute '${compute.name}'...`);
    logInfo("session", `[trace:prep:${sid}] provider.start begin`);
    await provider.start(compute);
    logInfo("session", `[trace:prep:${sid}] provider.start done`);
  }

  // Verify host is reachable before starting expensive sync/clone chain.
  // SSM transport keys off instance_id; no IP required.
  //
  // SSM Session Manager has variable cold-start latency: a first
  // `start-session` after the agent has been idle can take 10-25s while
  // Systems Manager establishes the WebSocket. Manual test from a warm
  // shell measures ~9-10s; under concurrent load (sync + clone in same
  // dispatch) the same call can slip past 15s. Use 45s as the per-attempt
  // timeout AND retry once on failure -- the retry path has a hot SSM
  // session and typically completes in <5s.
  const cfgRemote = compute.config as { instance_id?: string; region?: string; aws_profile?: string };
  const instanceId = cfgRemote.instance_id;
  if (instanceId) {
    const region = cfgRemote.region ?? "us-east-1";
    const awsProfile = cfgRemote.aws_profile;
    const { sshExecAsync, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
    const ssmConnectTimeoutMs = Number(process.env.ARK_SSM_CONNECT_TIMEOUT_MS ?? 45_000);

    log("Checking host connectivity (via SSM)...");
    logInfo("session", `[trace:prep:${sid}] connectivity-check begin`);
    let lastExitCode = -1;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { exitCode } = await sshExecAsync(sshKeyPath(compute.name), instanceId, "echo ok", {
          timeout: ssmConnectTimeoutMs,
          region,
          awsProfile,
        });
        lastExitCode = exitCode;
        if (exitCode === 0) break;
        log(`Connectivity check attempt ${attempt} returned exit=${exitCode}; retrying...`);
      } catch (err) {
        lastErr = err;
        log(`Connectivity check attempt ${attempt} threw: ${err instanceof Error ? err.message : String(err)}; retrying...`);
      }
    }
    if (lastExitCode !== 0) {
      const detail = lastErr ? ` (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : "";
      throw new Error(`Cannot reach compute '${compute.name}' at ${instanceId} (via SSM) after 2 attempts${detail}`);
    }
    logInfo("session", `[trace:prep:${sid}] connectivity-check done`);

    // Reverse tunnel back to the conductor. Required for normal operation:
    // the agent's ark hooks (curl to ${conductorUrl}/hooks/status) and the
    // ark-channel MCP server (ARK_CONDUCTOR_URL) both speak HTTP back to the
    // conductor over `localhost:<conductorPort>`. From EC2 that's the
    // instance's own loopback unless we tunnel; with the tunnel up (over SSM),
    // EC2 -> SSH -> conductor's localhost:<conductorPort>. Idempotent: if a
    // tunnel for this (instance_id, port) already exists we reuse it.
    const conductorPort = app.config.ports.conductor;
    const { setupReverseTunnel, setupForwardTunnel } = await import("../../compute/providers/ec2/ports.js");
    logInfo("session", `[trace:prep:${sid}] reverse-tunnel begin`);
    const tunnel = await setupReverseTunnel(sshKeyPath(compute.name), instanceId, conductorPort, {
      region,
      awsProfile,
    });
    logInfo("session", `[trace:prep:${sid}] reverse-tunnel done pid=${tunnel.pid} reused=${tunnel.reused}`);
    if (!tunnel.pid) {
      // Without the reverse tunnel, the agent's `ark hooks` (curl to
      // ${conductorUrl}/hooks/status) and the `ark-channel` MCP server
      // (ARK_CONDUCTOR_URL) have no path back to the conductor. The agent
      // runs on EC2 and sends every report to a closed loopback, so the
      // session sits silent at status=running until manual cancel. Treat
      // this as fatal -- mirrors the throw shape Pass 1 added for the new
      // arkd forward tunnel below.
      throw new Error(
        `Reverse tunnel did not register a PID for compute '${compute.name}' ` +
          `(localhost:${conductorPort} on ${instanceId} -> conductor) -- ` +
          `hooks + channel would be unreachable; aborting launch`,
      );
    }
    log(
      `Reverse tunnel ${tunnel.reused ? "reused" : "established"} (pid ${tunnel.pid}) ` +
        `localhost:${conductorPort} on ${compute.name} -> conductor`,
    );

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
    logInfo("session", `[trace:prep:${sid}] forward-tunnel begin`);
    const localPort = await allocatePort();
    const arkdTunnel = await setupForwardTunnel(sshKeyPath(compute.name), instanceId, DEFAULT_ARKD_PORT, localPort, {
      region,
      awsProfile,
    });
    logInfo("session", `[trace:prep:${sid}] forward-tunnel done pid=${arkdTunnel.pid} localPort=${arkdTunnel.localPort}`);
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

  // No sync from local. Every credential, env var, and project-scoped
  // file flows through typed-secret placement (env-var, ssh-private-key,
  // generic-blob, kubeconfig) or compute-template provisioning. The
  // legacy `syncEnvironment` path was wrong by construction in
  // control-plane mode (hosted conductor has no useful ~/.aws,
  // ~/.gitconfig, ~/.claude, gh auth token) and was the source of a
  // daemon-killer crash on EC2 dispatch (huge ~/.claude rsync over the
  // SSM tunnel). Sensitive project files belong in `ark secrets`; non-
  // sensitive ones in the repo.
  logInfo("session", `[trace:prep:${sid}] sync skipped -- credentials via typed secrets only`);

  // Apply container setup (Docker Compose + devcontainer)
  logInfo("session", `[trace:prep:${sid}] applyContainerSetup begin`);
  const finalLaunchContent = await applyContainerSetup(compute, effectiveWorkdir, opts?.launchContent ?? "", log);
  logInfo("session", `[trace:prep:${sid}] applyContainerSetup done`);

  logInfo("session", `[trace:prep:${sid}] return ports=${ports.length}`);
  return { finalLaunchContent, ports };
}
