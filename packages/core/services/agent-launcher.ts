/**
 * Agent process launching -- tmux launch, remote environment preparation, container setup.
 *
 * Extracted from session-orchestration.ts. All functions take app: AppContext as first arg.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { AppContext } from "../app.js";
import type { Session, Compute } from "../../types/index.js";
import type { ComputeProvider } from "../../compute/types.js";
import * as tmux from "../infra/tmux.js";
import * as agentRegistry from "../agent/agent.js";
import * as claude from "../claude/claude.js";
import { getProvider } from "../../compute/index.js";
import { resolvePortDecls, parseArcJson } from "../../compute/arc-json.js";
import { setupSessionWorktree } from "./worktree/index.js";

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

export async function _launchAgentTmux(
  app: AppContext,
  session: Session,
  stage: string,
  claudeArgs: string[],
  task: string,
  agent: agentRegistry.AgentDefinition,
  opts?: { autonomy?: string; onLog?: (msg: string) => void },
): Promise<string> {
  const log = opts?.onLog ?? (() => {});
  const tmuxName = `ark-${session.id}`;

  // Resolve compute + provider
  const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
  const provider = getProvider(compute?.provider ?? "local");

  // Setup worktree + trust
  const effectiveWorkdir = await setupSessionWorktree(app, session, compute, provider, log);

  // Determine conductor URL based on compute type
  const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
  const usesDevcontainer = arcJson?.devcontainer ?? false;
  const { DEFAULT_CONDUCTOR_URL, DOCKER_CONDUCTOR_URL } = await import("../constants.js");
  const conductorUrl = usesDevcontainer ? DOCKER_CONDUCTOR_URL : DEFAULT_CONDUCTOR_URL;

  // Channel config + launcher
  const channelPort = app.sessions.channelPort(session.id);
  const channelConfig = provider?.buildChannelConfig(session.id, stage, channelPort, { conductorUrl });
  const originalRepoDir = session.repo ? resolve(session.repo) : undefined;
  // Runtime-declared MCP servers + flow-level connectors. Runtime is the
  // broad opt-in (every session on this runtime gets the toolbelt); flow
  // connectors add per-flow MCP tools (e.g. a pi-sage-enabled review flow).
  // See packages/core/connectors/resolve.ts for the merge rules.
  const runtimeName = agent.runtime;
  const { collectMcpEntries, flowConnectorsFor } = await import("../connectors/index.js");
  const flowConnectors = flowConnectorsFor(app, session.flow);
  const runtimeMcpServers = collectMcpEntries(app, session, { runtimeName, flowConnectors });
  const { resolveMcpConfigsDir } = await import("../install-paths.js");
  const mcpConfigPath = claude.writeChannelConfig(session.id, stage, channelPort, effectiveWorkdir, {
    conductorUrl,
    channelConfig,
    tracksDir: app.config.dirs.tracks,
    originalRepoDir,
    runtimeMcpServers,
    mcpConfigsDir: resolveMcpConfigsDir(),
    enableCodeIntelV2: app.config.features.codeIntelV2,
  });

  // Status hooks + permissions allow-list -- write .claude/settings.local.json
  claude.writeSettings(session.id, conductorUrl, effectiveWorkdir, {
    autonomy: opts?.autonomy,
    agent: { tools: agent.tools, mcp_servers: agent.mcp_servers },
    tenantId: session.tenant_id ?? "default",
  });

  // Build launch env from agent config + provider-specific env (e.g. auth tokens for remote).
  // ARK_SESSION_DIR lets the launcher drop an exit-code sentinel when claude
  // exits non-zero; the status poller watches that path. See bug 3 in the
  // session-dispatch cascade fix.
  const sessionDirEnv = join(app.config.dirs.tracks, session.id);
  const launchEnv: Record<string, string> = {
    ...(agent.env ?? {}),
    ...(provider?.buildLaunchEnv(session) ?? {}),
    ARK_SESSION_DIR: sessionDirEnv,
  };

  const { content: launchContent, claudeSessionId } = claude.buildLauncher({
    workdir: effectiveWorkdir,
    claudeArgs,
    mcpConfigPath,
    prevClaudeSessionId: session.claude_session_id,
    env: launchEnv,
  });

  const launcher = tmux.writeLauncher(session.id, launchContent, app.config.dirs.tracks);

  // Save task for reference
  const sessionDir = join(app.config.dirs.tracks, session.id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "task.txt"), task);

  // Remote compute (providers that don't support local worktrees)
  if (compute && provider && !provider.supportsWorktree) {
    const { finalLaunchContent, ports } = await prepareRemoteEnvironment(
      app,
      session,
      compute,
      provider,
      effectiveWorkdir,
      {
        launchContent,
        onLog: log,
      },
    );

    // Launch via provider
    log("Launching on remote...");
    const result = await provider.launch(compute, session, {
      tmuxName,
      workdir: effectiveWorkdir,
      launcherContent: finalLaunchContent,
      ports,
    });

    await app.sessions.update(session.id, { claude_session_id: claudeSessionId });

    // Deliver task via channel (tunnels are now up, channel port is accessible locally)
    log("Delivering task...");
    claude.deliverTask(session.id, channelPort, task, stage);

    return result;
  }

  // Local launch via launcher abstraction
  log("Starting local session...");
  const launchResult = await app.launcher.launch(session, `bash ${launcher}`, {
    arkDir: app.config.dirs.ark,
    workdir: effectiveWorkdir,
  });
  claude.autoAcceptChannelPrompt(launchResult.handle);
  log("Delivering task...");
  claude.deliverTask(session.id, channelPort, task, stage);
  // Must await: under Temporal semantics this activity can return before
  // the DB write lands, leaving the next dispatch without a
  // claude_session_id to resume. Bun resolves synchronously today but
  // that's incidental -- mirrors the awaited write on the remote path.
  await app.sessions.update(session.id, { claude_session_id: claudeSessionId });

  return launchResult.handle;
}
