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
  if (arcJson?.compose === true && compute.config?.ip) {
    onLog("Starting Docker Compose services...");
    const { sshExec, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
    const { shellEscape } = await import("../../compute/providers/ec2/shell-escape.js");
    // `effectiveWorkdir` is a DB-persisted value derived (transitively) from
    // session.workdir / session.repo, both attacker-controllable in hosted
    // mode. Escape before interpolating into the remote shell.
    const quotedWorkdir = shellEscape(effectiveWorkdir);
    sshExec(sshKeyPath(compute.name), compute.config.ip as string, `cd ${quotedWorkdir} && docker compose up -d`);
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

  // Verify host is reachable before starting expensive sync/clone chain
  const ip = (compute.config as { ip?: string }).ip;
  if (ip) {
    log("Checking host connectivity...");
    const { sshExecAsync, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
    const { exitCode } = await sshExecAsync(sshKeyPath(compute.name), ip, "echo ok", { timeout: 15_000 });
    if (exitCode !== 0) {
      throw new Error(`Cannot reach compute '${compute.name}' at ${ip}`);
    }

    // Reverse tunnel back to the conductor. Required for normal operation:
    // the agent's ark hooks (curl to ${conductorUrl}/hooks/status) and the
    // ark-channel MCP server (ARK_CONDUCTOR_URL) both speak HTTP back to the
    // conductor over `localhost:<conductorPort>`. From EC2 that's the
    // instance's own loopback unless we tunnel; with the tunnel up,
    // EC2 → SSH → conductor's localhost:<conductorPort>. Idempotent: if a
    // tunnel for this (ip, port) already exists we reuse it.
    const conductorPort = app.config.ports.conductor;
    const { setupReverseTunnel } = await import("../../compute/providers/ec2/ports.js");
    const tunnel = await setupReverseTunnel(sshKeyPath(compute.name), ip, conductorPort);
    if (tunnel.pid) {
      log(`Reverse tunnel ${tunnel.reused ? "reused" : "established"} (pid ${tunnel.pid}) ` +
        `localhost:${conductorPort} on ${compute.name} -> conductor`);
    } else {
      log(`WARNING: reverse tunnel did not register a PID -- hooks/channel may be unreachable`);
    }
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
    log(`Credential sync failed (continuing): ${e?.message ?? e}`);
  }

  // Apply container setup (Docker Compose + devcontainer)
  const finalLaunchContent = await applyContainerSetup(compute, effectiveWorkdir, opts?.launchContent ?? "", log);

  return { finalLaunchContent, ports };
}
