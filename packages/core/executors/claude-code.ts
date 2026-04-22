/**
 * Claude Code executor -- wraps existing launch/kill/status/send/capture logic
 * from claude.ts, tmux.ts, and session.ts into the Executor interface.
 *
 * No new behavior -- this is a refactor that delegates to existing modules.
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { recordingPath } from "../recordings.js";

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";
import * as claude from "../claude/claude.js";
import * as tmux from "../infra/tmux.js";
import { parseArcJson } from "../../compute/arc-json.js";
import { getProvider } from "../../compute/index.js";

export const claudeCodeExecutor: Executor = {
  name: "claude-code",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const app = opts.app!;
    const log = opts.onLog ?? (() => {});
    const session = await app.sessions.get(opts.sessionId);
    if (!session) {
      return { ok: false, handle: "", message: `Session ${opts.sessionId} not found` };
    }

    const tmuxName = `ark-${session.id}`;
    const stage = opts.stage ?? "work";

    // Resolve compute + provider
    const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
    const provider = getProvider(compute?.provider ?? "local");

    // Setup worktree + trust (dynamic import to avoid circular dependency)
    const { setupSessionWorktree } = await import("../services/worktree/index.js");
    const effectiveWorkdir = await setupSessionWorktree(app, session, compute, provider, log);

    // Determine conductor URL based on compute type
    const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
    const usesDevcontainer = arcJson?.devcontainer ?? false;
    const { DEFAULT_CONDUCTOR_URL, DOCKER_CONDUCTOR_URL } = await import("../constants.js");
    const conductorUrl = usesDevcontainer ? DOCKER_CONDUCTOR_URL : DEFAULT_CONDUCTOR_URL;

    // Channel config + launcher
    const channelPort = app.sessions.channelPort(session.id);
    const channelConfig = provider?.buildChannelConfig(session.id, stage, channelPort, { conductorUrl });
    // Inject tenant id into the channel process env so outbound relay/report
    // requests carry X-Ark-Tenant-Id for multi-tenant scoping in the conductor.
    if (channelConfig && typeof channelConfig === "object") {
      const env = (channelConfig as Record<string, unknown>).env as Record<string, string> | undefined;
      if (env) {
        env.ARK_TENANT_ID = session.tenant_id ?? "default";
      } else {
        (channelConfig as Record<string, unknown>).env = { ARK_TENANT_ID: session.tenant_id ?? "default" };
      }
    }
    // Resolve the original repo path so MCP servers from the source repo's
    // .mcp.json can be merged into the worktree's .mcp.json.
    const originalRepoDir = session.repo ? resolve(session.repo) : undefined;
    // Runtime-declared MCP servers + flow-level connectors. Runtime is the
    // broad opt-in (every session on this runtime gets the toolbelt); flow
    // connectors add per-flow MCP tools. See connectors/resolve.ts for the
    // merge rules.
    const runtimeName = opts.agent.runtime;
    const { collectMcpEntries, flowConnectorsFor } = await import("../connectors/index.js");
    const flowConnectors = flowConnectorsFor(app, session.flow);
    const runtimeMcpServers = collectMcpEntries(app, session, { runtimeName, flowConnectors });
    const { resolveMcpConfigsDir } = await import("../install-paths.js");
    const mcpConfigPath = claude.writeChannelConfig(session.id, stage, channelPort, effectiveWorkdir, {
      conductorUrl,
      channelConfig,
      tracksDir: app.config.tracksDir,
      originalRepoDir,
      runtimeMcpServers,
      mcpConfigsDir: resolveMcpConfigsDir(),
    });

    // Verify MCP channel config was written
    try {
      const mcpContent = readFileSync(mcpConfigPath, "utf-8");
      const mcpParsed = JSON.parse(mcpContent);
      const hasChannel = !!mcpParsed?.mcpServers?.["ark-channel"];
      if (!hasChannel) {
        log(`CRITICAL: writeChannelConfig missing ark-channel in ${mcpConfigPath}`);
      }
    } catch (e: any) {
      log(`CRITICAL: failed to verify MCP config at ${mcpConfigPath}: ${e?.message ?? e}`);
    }

    // Status hooks + permissions allow-list -- MUST happen before agent launch.
    // The settings file configures Claude Code hooks (PreToolUse, Stop, etc.) that
    // report status back to the conductor. Without it, the conversation stays empty.
    // Uses writeSettingsVerified for fail-fast: if hooks are missing, the agent
    // would launch blind with no status reporting.
    const settingsResult = claude.writeSettingsVerified(session.id, conductorUrl, effectiveWorkdir, {
      autonomy: opts.autonomy,
      agent: { tools: opts.agent.tools, mcp_servers: opts.agent.mcp_servers },
      tenantId: session.tenant_id ?? "default",
    });

    if (!settingsResult.verified) {
      const errMsg = `Settings verification failed for ${session.id}: ${settingsResult.errors.join("; ")}`;
      log(`CRITICAL: ${errMsg}`);
      return { ok: false, handle: "", message: errMsg };
    }
    log(`Settings verified at ${settingsResult.path}: ${settingsResult.hookCount} hook events`);

    // Build launch env from agent config + provider-specific env + router URL (if enabled)
    const { buildRouterEnv } = await import("./router-env.js");
    // ARK_SESSION_DIR gives the launcher a place to drop the exit-code
    // sentinel when claude exits non-zero (bug 3 fix). The status poller
    // watches this same path. For remote compute the path refers to the
    // compute target filesystem; provider-specific remapping is out of
    // scope here and falls back to the launcher's /tmp default.
    const localSessionDir = join(app.config.tracksDir, session.id);
    const launchEnv: Record<string, string> = {
      ...(opts.agent.env ?? {}),
      ...(provider?.buildLaunchEnv(session) ?? {}),
      ...buildRouterEnv(app.config, { mode: "claude" }),
      // `opts.env` carries secrets resolved by dispatch; they override
      // every other env source so operator-rotated values take effect
      // on the next run without editing any YAML.
      ...(opts.env ?? {}),
      ARK_SESSION_DIR: localSessionDir,
    };

    const claudeArgs = opts.claudeArgs ?? [];
    const { content: launchContent, claudeSessionId } = claude.buildLauncher({
      workdir: effectiveWorkdir,
      claudeArgs,
      mcpConfigPath,
      prevClaudeSessionId: opts.prevClaudeSessionId ?? session.claude_session_id,
      env: launchEnv,
      initialPrompt: opts.initialPrompt,
    });

    const launcher = tmux.writeLauncher(session.id, launchContent, app.config.tracksDir);

    // Save task for reference
    const sessionDir = join(app.config.tracksDir, session.id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "task.txt"), opts.task);

    // Remote compute (providers that don't support local worktrees)
    if (compute && provider && !provider.supportsWorktree) {
      const { prepareRemoteEnvironment } = await import("../services/agent-launcher.js");
      const { finalLaunchContent, ports } = await prepareRemoteEnvironment(
        app,
        session,
        compute,
        provider,
        effectiveWorkdir,
        { launchContent, onLog: log },
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

      // Deliver task via channel
      log("Delivering task...");
      claude.deliverTask(session.id, channelPort, opts.task, stage);

      return { ok: true, handle: result, claudeSessionId };
    }

    // Local launch
    log("Starting local tmux session...");
    // tmux creates the pane at its default 120x50 and claude launches into
    // it immediately. When the web terminal attaches, the first client
    // resize calls `tmux resize-window`, which SIGWINCHes claude so its TUI
    // reflows. pty_cols / pty_rows stay NULL until that first resize.
    // See packages/server/index.ts for the /terminal/:sessionId proxy.
    await tmux.createSessionAsync(tmuxName, `bash ${launcher}`, {
      arkDir: app.config.arkDir,
    });
    const rootPid = await tmux.getPanePidAsync(tmuxName);

    // Start recording terminal output for post-session replay
    const recPath = recordingPath(app.config.arkDir, session.id);
    mkdirSync(join(app.config.arkDir, "recordings"), { recursive: true });
    await tmux.pipePaneAsync(tmuxName, recPath);

    claude.autoAcceptChannelPrompt(tmuxName);
    app.sessions.update(session.id, { claude_session_id: claudeSessionId });

    return { ok: true, handle: tmuxName, pid: rootPid ?? undefined, claudeSessionId };
  },

  async kill(handle: string): Promise<void> {
    await tmux.killSessionAsync(handle);
  },

  async status(handle: string): Promise<ExecutorStatus> {
    const exists = await tmux.sessionExistsAsync(handle);
    if (exists) {
      return { state: "running" };
    }
    return { state: "not_found" };
  },

  async send(handle: string, message: string): Promise<void> {
    await tmux.sendTextAsync(handle, message);
  },

  async capture(handle: string, lines?: number): Promise<string> {
    return tmux.capturePaneAsync(handle, { lines });
  },
};
