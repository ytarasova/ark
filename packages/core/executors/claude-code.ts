/**
 * Claude Code executor — wraps existing launch/kill/status/send/capture logic
 * from claude.ts, tmux.ts, and session.ts into the Executor interface.
 *
 * No new behavior — this is a refactor that delegates to existing modules.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";
import * as claude from "../claude.js";
import * as tmux from "../tmux.js";
import { TRACKS_DIR, sessionChannelPort } from "../store.js";
import { getApp } from "../app.js";
import { parseArcJson } from "../../compute/arc-json.js";
import { getProvider } from "../../compute/index.js";

export const claudeCodeExecutor: Executor = {
  name: "claude-code",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const log = opts.onLog ?? (() => {});
    const session = getApp().sessions.get(opts.sessionId);
    if (!session) {
      return { ok: false, handle: "", message: `Session ${opts.sessionId} not found` };
    }

    const tmuxName = `ark-${session.id}`;
    const stage = opts.stage ?? "work";

    // Resolve compute + provider
    const compute = session.compute_name ? getApp().computes.get(session.compute_name) : null;
    const provider = getProvider(compute?.provider ?? "local");

    // Setup worktree + trust (dynamic import to avoid circular dependency)
    const { setupSessionWorktree } = await import("../session.js");
    const effectiveWorkdir = await setupSessionWorktree(session, compute, provider, log);

    // Determine conductor URL based on compute type
    const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
    const usesDevcontainer = arcJson?.devcontainer ?? false;
    const conductorUrl = usesDevcontainer
      ? "http://host.docker.internal:19100"
      : "http://localhost:19100";

    // Channel config + launcher
    const channelPort = sessionChannelPort(session.id);
    const channelConfig = provider?.buildChannelConfig(session.id, stage, channelPort, { conductorUrl });
    const mcpConfigPath = claude.writeChannelConfig(session.id, stage, channelPort, effectiveWorkdir, { conductorUrl, channelConfig });

    // Status hooks
    claude.writeHooksConfig(session.id, conductorUrl, effectiveWorkdir, { autonomy: opts.autonomy });

    // Build launch env from agent config + provider-specific env
    const launchEnv = { ...(opts.agent.env ?? {}), ...(provider?.buildLaunchEnv(session as any) ?? {}) };

    const claudeArgs = opts.claudeArgs ?? [];
    const { content: launchContent, claudeSessionId } = claude.buildLauncher({
      workdir: effectiveWorkdir,
      claudeArgs,
      mcpConfigPath,
      prevClaudeSessionId: opts.prevClaudeSessionId ?? session.claude_session_id,
      sessionName: opts.sessionName ?? session.summary ?? session.id,
      env: launchEnv,
    });

    const launcher = tmux.writeLauncher(session.id, launchContent);

    // Save task for reference
    const sessionDir = join(TRACKS_DIR(), session.id);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "task.txt"), opts.task);

    // Remote compute (providers that don't support local worktrees)
    if (compute && provider && !provider.supportsWorktree) {
      const { prepareRemoteEnvironment } = await import("../session.js");
      const { finalLaunchContent, ports } = await prepareRemoteEnvironment(
        session, compute, provider, effectiveWorkdir,
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

      getApp().sessions.update(session.id, { claude_session_id: claudeSessionId });

      // Deliver task via channel
      log("Delivering task...");
      claude.deliverTask(session.id, channelPort, opts.task, stage);

      return { ok: true, handle: result, claudeSessionId };
    }

    // Local launch
    log("Starting local tmux session...");
    await tmux.createSessionAsync(tmuxName, `bash ${launcher}`);
    claude.autoAcceptChannelPrompt(tmuxName);
    log("Delivering task...");
    claude.deliverTask(session.id, channelPort, opts.task, stage);
    getApp().sessions.update(session.id, { claude_session_id: claudeSessionId });

    return { ok: true, handle: tmuxName, claudeSessionId };
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
