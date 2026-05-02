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
import { logWarn } from "../observability/structured-log.js";

/**
 * Default home directory on EC2 / k8s remote hosts. Used as the
 * remote-safe fallback for `launcherWorkdir` when a remote dispatch has
 * no clone source (bare worktree dispatch). Hard-coded to mirror
 * `packages/compute/providers/ec2/constants.ts:REMOTE_HOME` -- duplicated
 * here so this executor module avoids a cross-package import on the
 * compute layer.
 */
const REMOTE_HOME_FALLBACK = "/home/ubuntu";

/**
 * Resolve the workdir paths used by remote dispatch:
 *   - `launcher`: where the launcher script's `cd` and embedded-file
 *      heredocs target on the agent's host. MUST NOT be the conductor's
 *      filesystem path (e.g. `/Users/...`); falls back to REMOTE_HOME
 *      when the provider can't compute one (bare-worktree remote dispatch).
 *   - `runTarget`: what's threaded into `runTargetLifecycle.workspace.remoteWorkdir`.
 *      Falls back to `null` so prepare-workspace cleanly skips on bare-worktree
 *      rather than asking the lifecycle to clone into a conductor-shaped path.
 *
 * For local dispatch (`isRemote=false`) both fields fall through to the
 * conductor-side `effectiveWorkdir`, which is correct -- the agent runs
 * on the conductor.
 *
 * Pure: no I/O. Easy to unit-test against a stub provider.
 */
export function resolveRemoteWorkdirs(opts: {
  isRemote: boolean;
  effectiveWorkdir: string | null;
  resolveWorkdir: (() => string | null) | undefined;
  /** Hook invoked when a remote dispatch falls back to REMOTE_HOME. Tests pass a spy. */
  onFallback?: (reason: string) => void;
}): { launcher: string; runTarget: string | null } {
  const { isRemote, effectiveWorkdir, resolveWorkdir, onFallback } = opts;
  if (!isRemote) {
    // Local: agent runs on the conductor; effectiveWorkdir is the right answer
    // for both fields. effectiveWorkdir may be null on bare-worktree local
    // dispatch -- callers handle that downstream.
    return { launcher: effectiveWorkdir ?? "", runTarget: effectiveWorkdir ?? null };
  }
  const resolved = resolveWorkdir ? resolveWorkdir() : null;
  if (resolved) {
    return { launcher: resolved, runTarget: resolved };
  }
  // Remote dispatch with no resolveWorkdir result. The conductor's path
  // would be `/Users/...` which doesn't exist on Ubuntu; bake REMOTE_HOME
  // into the launcher's `cd` instead so the script doesn't fail with
  // `cd: no such file or directory`. Run-target stays null so
  // prepare-workspace skips cleanly (bare-worktree dispatch surfaces the
  // misconfig at the agent stage rather than masquerading as a clone).
  onFallback?.(
    "remote dispatch has no resolveWorkdir result (no --remote-repo? bare worktree?); " +
      `falling back to ${REMOTE_HOME_FALLBACK} for launcher cwd, null for prepare-workspace`,
  );
  return { launcher: REMOTE_HOME_FALLBACK, runTarget: null };
}

/**
 * Audit finding F6 guard. Remote dispatch must receive an explicit
 * `channelConfig` from the provider (e.g. RemoteWorktreeProvider's
 * `buildChannelConfig` returns `${REMOTE_HOME}/.ark/bin/ark channel` --
 * the binary path on the agent's host). When `channelConfig` is null /
 * undefined / empty, `buildChannelConfig` in mcp-config.ts falls back to
 * `channelMcpConfig` -> `channelLaunchSpec()` -> `process.execPath`,
 * i.e. the *conductor's* bun/ark binary path. That path doesn't exist on
 * EC2/k8s; the agent's claude tries to spawn the channel server, fails on
 * ENOENT, and the session never establishes a channel.
 *
 * Returns null on success (channelConfig is acceptable), or a descriptive
 * error message string on failure (caller surfaces this through the
 * launcher's normal error path).
 *
 * Pure: no I/O. Easy to unit-test.
 */
export function assertRemoteChannelConfig(
  channelConfig: Record<string, unknown> | null | undefined,
  providerName: string | undefined,
): string | null {
  if (!channelConfig || typeof channelConfig !== "object" || Object.keys(channelConfig).length === 0) {
    return (
      `channel config required for remote dispatch but provider '${providerName ?? "<unknown>"}' ` +
      `returned no channelConfig. The conductor's process.execPath would be embedded in .mcp.json, ` +
      `which doesn't exist on the remote host. Fix: provider.buildChannelConfig must return a non-null ` +
      `record (see RemoteWorktreeProvider.buildChannelConfig for the canonical shape).`
    );
  }
  return null;
}

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
    // host, where the reverse tunnel established by `EC2Compute.setupTransport`
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
    // need a translation (e.g. EC2Compute resolves to
    // `${REMOTE_HOME}/Projects/<sid>/<repo>`) implement `resolveWorkdir`;
    // the returned path drives both the heredoc target for embedded
    // files AND the workdir threaded into `runTargetLifecycle` so tmux's
    // `-c <workdir>` and the launcher agree.
    //
    // When `resolveWorkdir` returns null (bare-worktree remote dispatch
    // with no `--remote-repo`), pre-fix this silently fell through to
    // `effectiveWorkdir` -- the conductor's local path -- and the launcher
    // `cd`'d into a non-existent /Users/... path on Ubuntu. Audit finding
    // F3 traced that to the silent fallback; we now bounce through
    // `resolveRemoteWorkdirs` which uses REMOTE_HOME for the launcher and
    // null for the run-target's prepare-workspace argument.
    const { launcher: launcherWorkdir } = resolveRemoteWorkdirs({
      isRemote,
      effectiveWorkdir,
      resolveWorkdir:
        compute && provider?.resolveWorkdir ? () => provider.resolveWorkdir!(compute, session) : undefined,
      onFallback: (reason) => log(`launcherWorkdir: ${reason}`),
    });

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
      // Audit finding F6: REMOTE dispatch MUST receive an explicit
      // `channelConfig` from the provider (see assertRemoteChannelConfig
      // for the full rationale). Fail fast instead of producing a broken
      // `.mcp.json` that embeds the conductor's binary path.
      const channelErr = assertRemoteChannelConfig(channelConfig, provider?.name);
      if (channelErr) {
        log(`CRITICAL: ${channelErr}`);
        return { ok: false, handle: "", message: channelErr };
      }

      // Build JSON content for both files (no I/O on the conductor).
      const channel = claude.buildChannelConfig(session.id, stage, channelPort, {
        conductorUrl,
        channelConfig,
        // No `originalRepoDir` for remote -- the source repo is on the
        // conductor; the remote freshly clones in
        // `Compute.prepareWorkspace` (driven from `runTargetLifecycle`).
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

      // Hooks curl arkd's `/hooks/forward`, not the conductor's
      // `/hooks/status`. Arkd is reachable from the agent at localhost on
      // the agent's host (EC2 in remote mode, laptop in local mode), so
      // `localhost:<arkd_port>` is correct on whichever side runs the
      // launcher script. The conductor pulls from arkd's `/events/stream`
      // over the existing forward tunnel and re-dispatches each event.
      const arkdHookUrl = `http://localhost:${app.config.ports.arkd}`;
      const settings = claude.buildSettings(session.id, arkdHookUrl, {
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

      // Same arkd hook URL as the remote path -- launcher runs on the
      // host where arkd lives, so localhost:<arkd_port> resolves correctly
      // in both local and remote modes.
      const arkdHookUrl = `http://localhost:${app.config.ports.arkd}`;
      const settingsResult = claude.writeSettingsVerified(session.id, arkdHookUrl, effectiveWorkdir, {
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
    // through the reverse tunnel set up by `EC2Compute.setupTransport`. We
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
    //
    // We also embed `task.txt` under `${ARK_SESSION_DIR}/task.txt` so the
    // PostCompact hook (see settings.ts:postCompactTaskHook) can re-inject the
    // original task on the agent's host after compaction. The conductor-side
    // write below (`writeFileSync(sessionDir/task.txt)`) is irrelevant on
    // remote -- that path is `/Users/<name>/.ark/...` and doesn't exist on
    // Ubuntu. Without this file, every PostCompact hook silently no-ops.
    const embedFiles =
      isRemote && mcpJsonContent && settingsJsonContent
        ? [
            { relPath: mcpRelPath, content: mcpJsonContent },
            { relPath: settingsRelPath, content: settingsJsonContent },
            { relPath: `${sessionDirEnv}/task.txt`, content: opts.task },
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

    // Remote compute (providers that don't support local worktrees).
    //
    // Routes through ComputeTarget. `runTargetLifecycle`
    // walks the per-dispatch lifecycle inside structured `provisioning_step`
    // events: compute-start (if stopped) -> ensure-reachable -> flush-secrets
    // -> prepare-workspace -> isolation-prepare -> launch-agent. Each step is
    // optional on the compute (LocalCompute is a no-op for ensureReachable /
    // prepareWorkspace / flushPlacement); the helper skips any method the
    // impl omits.
    if (compute && provider && !provider.supportsWorktree) {
      const { resolveTargetAndHandle } = await import("../services/dispatch/target-resolver.js");
      const { runTargetLifecycle } = await import("../services/dispatch/target-lifecycle.js");
      const { resolvePortDecls } = await import("../../compute/arc-json.js");

      const { target, handle } = await resolveTargetAndHandle(app, session);
      if (!target || !handle) {
        return { ok: false, handle: "", message: "no compute target resolved for remote dispatch" };
      }

      // `target.compute.resolveWorkdir` mirrors the legacy
      // `provider.resolveWorkdir(compute, session)` shape used to build
      // `launcherWorkdir` above (both yield `${REMOTE_HOME}/Projects/<sid>/<repo>`
      // for the EC2 family). We re-resolve here through the Compute interface
      // so the new path doesn't depend on the legacy provider hook -- the two
      // results agree for every shipping Compute kind.
      //
      // Fallback to `null` (NOT `effectiveWorkdir`): when the compute can't
      // compute a remote workdir (bare worktree dispatch with no
      // --remote-repo), the conductor's `effectiveWorkdir` is a /Users/...
      // path that doesn't exist on Ubuntu. `runTargetLifecycle` skips
      // prepareWorkspace cleanly when remoteWorkdir is null; that's the
      // honest signal "no workspace to prepare" instead of asking the
      // lifecycle to clone into a conductor-shaped path. Audit finding F3.
      const { runTarget: remoteWorkdir } = resolveRemoteWorkdirs({
        isRemote: true,
        effectiveWorkdir,
        resolveWorkdir: target.compute.resolveWorkdir
          ? () => target.compute.resolveWorkdir!(handle, session)
          : undefined,
        onFallback: (reason) => logWarn("session", `remote workdir fallback for session ${session.id}: ${reason}`),
      });
      const ports = remoteWorkdir ? resolvePortDecls(remoteWorkdir) : [];
      if (ports.length > 0) {
        await app.sessions.update(session.id, { config: { ...session.config, ports } });
      }

      // Source URL/path for the per-session worktree. Prefer the
      // remote-clone URL the user passed via `--remote-repo` (typed via
      // `session.config.remoteRepo`); fall back to `session.repo` for
      // co-located compute kinds. Null suppresses prepare-workspace --
      // bare-worktree dispatch surfaces the misconfig at the agent stage.
      const cloneSource = (session.config as { remoteRepo?: string } | null)?.remoteRepo ?? session.repo ?? null;

      log("Launching on remote...");
      const agentHandle = await runTargetLifecycle(
        app,
        session.id,
        target,
        handle,
        {
          tmuxName,
          workdir: remoteWorkdir,
          launcherContent: launchContent,
          ports,
        },
        {
          prepareCtx: { workdir: remoteWorkdir, onLog: log },
          workspace: { source: cloneSource, remoteWorkdir },
          placement: opts.placement,
          computeStatus: compute.status,
        },
      );

      await app.sessions.update(session.id, { claude_session_id: claudeSessionId });

      // Skip deliverTask on remote dispatch. The fallback path inside
      // deliverTask hits `localhost:<channelPort>` from the conductor's
      // perspective, but for a remote launch the channel runs on the EC2
      // box -- the conductor's loopback can't reach it. The 60-retry loop
      // would just time out and the executor (which already returned) would
      // never know. The initial prompt is baked into launch.sh anyway, so
      // there's nothing to deliver here.
      log("Skipping deliverTask (remote launch -- prompt baked into launch.sh)");

      return { ok: true, handle: agentHandle.sessionName, claudeSessionId };
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
