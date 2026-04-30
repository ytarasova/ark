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

    // Resolve compute + provider via the polymorphic AppContext helper so
    // hosted sessions without an explicit `compute_name` resolve to null
    // (caller surfaces "no compute resolved") rather than silently
    // defaulting to LocalProvider.
    const { provider, compute } = await app.resolveProvider(session);

    // Setup worktree + trust (dynamic import to avoid circular dependency)
    const { setupSessionWorktree } = await import("../services/worktree/index.js");
    const effectiveWorkdir = await setupSessionWorktree(app, session, compute, provider, log);

    // Determine conductor URL based on compute type. Default + remote both
    // use `http://localhost:<port>` -- for remote that resolves on the EC2
    // host, where the reverse tunnel established by prepareRemoteEnvironment
    // forwards back to the conductor's actual port. Read the live port from
    // app.config so a non-default `--conductor-port` is reflected in the
    // baked-in URL (DEFAULT_CONDUCTOR_URL is hardcoded to 19100 and would
    // mismatch if the user moved the conductor).
    const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
    const usesDevcontainer = arcJson?.devcontainer ?? false;
    const { DOCKER_CONDUCTOR_URL } = await import("../constants.js");
    const localConductorUrl = `http://localhost:${app.config.ports.conductor}`;
    const conductorUrl = usesDevcontainer ? DOCKER_CONDUCTOR_URL : localConductorUrl;

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

    const isRemote = !!(compute && provider && !provider.supportsWorktree);

    // For remote dispatch the launcher must `cd` into the workdir on the
    // REMOTE host -- not the conductor's local Mac path. Providers that
    // need a translation (e.g. RemoteWorktreeProvider clones to
    // `${REMOTE_HOME}/Projects/<repo>`) implement `resolveWorkdir`; the
    // returned path also drives the heredoc target for the embedded files,
    // and is passed through to `provider.launch` so tmux's `-c <workdir>`
    // and the launcher agree.
    const launcherWorkdir =
      isRemote && compute && provider?.resolveWorkdir
        ? (provider.resolveWorkdir(compute, session) ?? effectiveWorkdir)
        : effectiveWorkdir;

    // For LOCAL dispatch: write `.mcp.json` + `.claude/settings.local.json`
    // directly into the local workdir Claude will run in. For REMOTE dispatch
    // we skip the local writes (the workdir on the conductor is irrelevant)
    // and instead build the JSON in-memory and ship it to the remote workdir
    // via the launcher's embedFiles heredocs (see buildLauncher below). Same
    // builders, two delivery vehicles -- no rsync from the conductor.
    let mcpConfigPath: string;
    let mcpJsonContent: string | null = null;
    let settingsJsonContent: string | null = null;
    const settingsRelPath = ".claude/settings.local.json";
    const mcpRelPath = ".mcp.json";

    if (isRemote) {
      // Build JSON content for both files (no I/O on the conductor).
      const channel = claude.buildChannelConfig(session.id, stage, channelPort, {
        conductorUrl,
        channelConfig,
        // No `originalRepoDir` for remote -- the source repo is on the
        // conductor; the remote freshly clones in `provider.launch`.
        runtimeMcpServers,
        mcpConfigsDir: resolveMcpConfigsDir(),
        // codebase-memory binary lives on the conductor's filesystem; the
        // path won't exist on EC2/k8s. Skip the probe.
        includeLocalCodebaseMemory: false,
      });
      mcpJsonContent = channel.content;
      const hasChannel = !!channel.object?.mcpServers?.["ark-channel"];
      if (!hasChannel) {
        log(`CRITICAL: buildChannelConfig produced no ark-channel entry for remote dispatch`);
      }

      const settings = claude.buildSettings(session.id, conductorUrl, {
        autonomy: opts.autonomy,
        agent: { tools: opts.agent.tools, mcp_servers: opts.agent.mcp_servers },
        tenantId: session.tenant_id ?? "default",
      });
      settingsJsonContent = settings.content;
      log(
        `Remote settings + MCP built: ${settings.hookCount} hook events; ` +
          `${Object.keys((channel.object as { mcpServers?: Record<string, unknown> })?.mcpServers ?? {}).length} mcp servers`,
      );

      // mcpConfigPath is referenced by buildLauncher's `mcpConfigPath` field.
      // For remote, point at the path the launcher heredoc will write on the
      // remote host, not a conductor-side path.
      mcpConfigPath = `${launcherWorkdir}/${mcpRelPath}`;
    } else {
      // Local: write both files atomically into the local workdir as before.
      mcpConfigPath = claude.writeChannelConfig(session.id, stage, channelPort, effectiveWorkdir, {
        conductorUrl,
        channelConfig,
        tracksDir: app.config.dirs.tracks,
        originalRepoDir,
        runtimeMcpServers,
        mcpConfigsDir: resolveMcpConfigsDir(),
      });

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
    }

    // Build launch env from agent config + provider-specific env + router URL (if enabled)
    const { buildRouterEnv } = await import("./router-env.js");
    // ARK_SESSION_DIR is where the launcher writes its exit-code sentinel
    // when claude exits non-zero. For LOCAL dispatch it points at the
    // conductor's tracks dir (status-poller.ts watches that path). For
    // REMOTE dispatch the conductor can't read EC2's filesystem, so the
    // sentinel mechanism doesn't apply -- session completion is reported
    // via the ark hooks (Stop / SessionEnd / StopFailure) curling back
    // through the reverse tunnel set up in prepareRemoteEnvironment. We
    // still need ARK_SESSION_DIR set to *something* writable on the
    // remote; otherwise the launcher would `mkdir -p` the conductor's
    // path on the EC2 host, leaving a phantom `/Users/<name>/.ark/...`
    // tree on the wrong filesystem. /tmp is per-instance ephemeral and
    // always writable by the ubuntu user.
    const localSessionDir = join(app.config.dirs.tracks, session.id);
    const sessionDirEnv = isRemote ? `/tmp/ark-session-${session.id}` : localSessionDir;
    const launchEnv: Record<string, string> = {
      ...(opts.agent.env ?? {}),
      ...(provider?.buildLaunchEnv(session) ?? {}),
      ...buildRouterEnv(app.config, { mode: "claude" }),
      // `opts.env` carries secrets resolved by dispatch; they override
      // every other env source so operator-rotated values take effect
      // on the next run without editing any YAML.
      ...(opts.env ?? {}),
      ARK_SESSION_DIR: sessionDirEnv,
    };

    const claudeArgs = opts.claudeArgs ?? [];
    // For remote dispatch, embed the .mcp.json and .claude/settings.local.json
    // JSON we just built as heredocs in the launcher script. The launcher writes
    // them in the remote workdir on first run -- no conductor-side files cross
    // the wire, no rsync.
    const embedFiles =
      isRemote && mcpJsonContent && settingsJsonContent
        ? [
            { relPath: mcpRelPath, content: mcpJsonContent },
            { relPath: settingsRelPath, content: settingsJsonContent },
          ]
        : undefined;
    const { content: launchContent, claudeSessionId } = claude.buildLauncher({
      workdir: launcherWorkdir,
      claudeArgs,
      mcpConfigPath,
      prevClaudeSessionId: opts.prevClaudeSessionId ?? session.claude_session_id,
      env: launchEnv,
      initialPrompt: opts.initialPrompt,
      embedFiles,
      // Local dispatch already runs trustDirectory() in the worktree
      // setup path against the conductor's ~/.claude.json. Remote needs
      // the same writes to land on the EC2/k8s host -- the launcher
      // embeds a jq merge that flips hasCompletedOnboarding +
      // projects[workdir].hasTrustDialogAccepted before claude starts.
      preAcceptClaudeUx: isRemote,
    });

    const launcher = tmux.writeLauncher(session.id, launchContent, app.config.dirs.tracks);

    // Save task for reference
    const sessionDir = join(app.config.dirs.tracks, session.id);
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

      // Launch via provider. Pass launcherWorkdir (== resolveWorkdir on
      // remote) so tmux's `-c <workdir>` agrees with the launcher's `cd`.
      // `placement` is the deferred ctx the dispatcher built pre-launch:
      // SSH-medium providers flush its queued file ops onto a real ctx
      // here, after `prepareRemoteEnvironment` has guaranteed the IP.
      log("Launching on remote...");
      const result = await provider.launch(compute, session, {
        tmuxName,
        workdir: launcherWorkdir,
        launcherContent: finalLaunchContent,
        ports,
        placement: opts.placement,
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
      arkDir: app.config.dirs.ark,
    });
    const rootPid = await tmux.getPanePidAsync(tmuxName);

    // Start recording terminal output for post-session replay
    const recPath = recordingPath(app.config.dirs.ark, session.id);
    mkdirSync(join(app.config.dirs.ark, "recordings"), { recursive: true });
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
