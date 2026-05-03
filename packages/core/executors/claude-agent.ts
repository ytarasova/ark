/**
 * claude-agent executor -- builds a launcher script + delegates to the
 * arkd-backed provider for ALL dispatches. One uniform path: local arkd
 * vs remote-arkd (over SSM tunnel) is the provider's concern; this
 * executor doesn't see the difference.
 *
 *   provider.spawnProcess(compute, session, { handle, cmd, args, workdir, logPath })
 *     -> arkd `/process/spawn` (generic, no tmux)
 *     -> launcher writes task.txt, runs `ark run-agent-sdk`, exits when
 *        the SDK loop returns end_turn (or aborts on SIGTERM)
 *     -> hooks publish to arkd's `hooks` channel; conductor subscribes
 *        via `/channel/hooks/subscribe`
 *
 * Status / kill / capture / sendUserMessage all defer to provider methods
 * (`statusProcessByHandle`, `killProcessByHandle`, `captureOutput`,
 * `sendUserMessage`) so lifecycle calls go through the same wire.
 */

import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

import type { Executor, LaunchOpts, LaunchResult, ExecutorStatus } from "../executor.js";
import { logInfo, logWarn, logError } from "../observability/structured-log.js";

/**
 * Project the claude-agent runtime YAML's optional fields into the env vars
 * launch.ts (and the bundled claude binary it spawns) read at runtime.
 *
 * Mapping:
 *   - `compat: ["bedrock", ...]`     -> ARK_COMPAT (comma-joined)
 *   - `default_haiku_model: "<id>"`  -> ANTHROPIC_DEFAULT_HAIKU_MODEL
 *
 * Exported for unit testing without booting an AppContext.
 */
export function buildAgentSdkRuntimeEnv(runtimeDef: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  const def = runtimeDef as { compat?: unknown; default_haiku_model?: unknown } | null | undefined;

  const compat = Array.isArray(def?.compat)
    ? (def.compat as unknown[]).filter((c): c is string => typeof c === "string" && c.length > 0)
    : [];
  if (compat.length > 0) env.ARK_COMPAT = compat.join(",");

  const haiku = def?.default_haiku_model;
  if (typeof haiku === "string" && haiku.length > 0) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haiku;
  }

  return env;
}

export const claudeAgentExecutor: Executor = {
  name: "claude-agent",

  async launch(opts: LaunchOpts): Promise<LaunchResult> {
    const app = opts.app!;
    const session = await app.sessions.get(opts.sessionId);
    if (!session) {
      return { ok: false, handle: "", message: `Session ${opts.sessionId} not found` };
    }

    if (app.mode.kind === "hosted") {
      return {
        ok: false,
        handle: "",
        message:
          "claude-agent executor is local-mode only -- per-session state writes to the conductor's " +
          "tracks dir which lives on the pod's ephemeral disk in hosted mode. Use claude-code on a " +
          "real compute target for hosted deployments.",
      };
    }

    // Conductor-side session dir for the executor's log tee (stdio.log) so
    // `ark session output` and the dashboard's Logs tab have something to
    // read while arkd is still being provisioned. The agent's own
    // transcript.jsonl + stdio.log live on the WORKER under /tmp/ark-<sid>
    // and are surfaced via arkd /file/read.
    const sessionDir = join(app.config.dirs.tracks, session.id);
    mkdirSync(sessionDir, { recursive: true });
    const stdioPath = join(sessionDir, "stdio.log");

    const log = (msg: string): void => {
      if (opts.onLog) opts.onLog(msg);
      try {
        appendFileSync(stdioPath, `[exec ${new Date().toISOString()}] ${msg}\n`);
      } catch {
        /* stdio.log not writable yet -- the upstream onLog still fired */
      }
    };

    // Resolve provider + compute. claude-agent always runs on an arkd-backed
    // provider (local-arkd, remote-arkd-ec2, remote-arkd-k8s, ...). Anything
    // else means the compute row is misconfigured.
    const { provider, compute } = await app.resolveProvider(session);
    if (!provider || !compute) {
      const msg = `no compute resolved for session.compute_name='${session.compute_name ?? "(none)"}'`;
      logError("session", `claude-agent.launch: ${msg}`, { sessionId: session.id });
      return { ok: false, handle: "", message: msg };
    }
    if (!provider.spawnProcess) {
      const msg = `provider '${provider.name}' has no spawnProcess; claude-agent requires arkd /process/spawn`;
      logError("session", `claude-agent.launch: ${msg}`, { sessionId: session.id, provider: provider.name });
      return { ok: false, handle: "", message: msg };
    }
    logInfo("session", "claude-agent.launch: provider resolved", {
      sessionId: session.id,
      provider: provider.name,
      compute: compute.name,
      computeKind: compute.compute_kind,
    });

    const { setupSessionWorktree } = await import("../services/worktree/index.js");
    const effectiveWorkdir = await setupSessionWorktree(app, session, compute, provider, log);

    // Worker-side paths. We use `/tmp/ark-<sid>` UNIFORMLY -- local and
    // remote both. For local dispatch worker == conductor so /tmp lives on
    // the same filesystem; for remote it's the worker's /tmp. The agent
    // writes transcript.jsonl + stdio.log into this dir; the conductor
    // reads them back via arkd's /file/read regardless of where it runs.
    // `provider.resolveWorkdir` is the only path question still polymorphic
    // because workdir CAN be a real worktree directory the provider
    // controls (e.g. EC2 maps the cloned repo to /home/ubuntu/Projects/...);
    // session scratch is always /tmp/ark-<sid>.
    const workerSessionDir = `/tmp/ark-${session.id}`;
    const workerWorkdir = provider.resolveWorkdir?.(compute, session) ?? effectiveWorkdir ?? null;
    const workerPromptFile = `${workerSessionDir}/task.txt`;
    const workerLauncherPath = `${workerSessionDir}/launcher.sh`;
    const workerLogPath = `${workerSessionDir}/stdio.log`;
    const handle = `ark-${session.id}`;

    // Build ARK_* env vars. ARK_ARKD_URL=localhost:19300 is the AGENT'S view
    // of arkd from the worker (loopback). For shared-fs / local dispatch
    // that's the same arkd the conductor uses; for remote it's the worker's
    // own arkd, with the SSM tunnel handling the conductor side.
    const arkEnv: Record<string, string> = {
      ARK_SESSION_ID: session.id,
      ARK_SESSION_DIR: workerSessionDir,
      ARK_WORKTREE: workerWorkdir ?? session.workdir ?? session.repo ?? "",
      ARK_PROMPT_FILE: workerPromptFile,
      ARK_ARKD_URL: "http://localhost:19300",
    };
    if (opts.agent.model) arkEnv.ARK_MODEL = opts.agent.model;
    if (opts.agent.max_turns && opts.agent.max_turns > 0) arkEnv.ARK_MAX_TURNS = String(opts.agent.max_turns);
    const maxBudget = (opts.agent as Record<string, unknown>).max_budget_usd as number | undefined;
    if (maxBudget != null) arkEnv.ARK_MAX_BUDGET_USD = String(maxBudget);
    const systemAppend = (opts.agent as Record<string, unknown>).system_prompt as string | undefined;
    if (systemAppend) arkEnv.ARK_SYSTEM_PROMPT_APPEND = systemAppend;
    if (session.tenant_id) arkEnv.ARK_TENANT_ID = session.tenant_id;

    const runtimeDef = await app.runtimes?.get?.("claude-agent");
    Object.assign(arkEnv, buildAgentSdkRuntimeEnv(runtimeDef));

    // Secrets (ANTHROPIC_API_KEY etc.) take precedence -- last-write-wins.
    const secretEnv = opts.env ?? {};

    // Launcher script: write task.txt, export env, exec ark run-agent-sdk.
    // No `exec bash` keepalive -- the headless SDK loop exits on end_turn,
    // arkd reaps the process, and the next stage's spawn happens cleanly
    // under the same handle once kill releases it.
    const { shellQuote } = await import("../claude/args.js");
    const exports = Object.entries({ ...arkEnv, ...secretEnv })
      .map(([k, v]) => `export ${k}=${shellQuote(String(v))}`)
      .join("\n");

    const launcherContent = [
      "#!/bin/bash",
      'export PATH="$HOME/.ark/bin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"',
      `mkdir -p ${shellQuote(workerSessionDir)}`,
      `cat > ${shellQuote(workerPromptFile)} <<'ARK_EOF_PROMPT'`,
      opts.task,
      "ARK_EOF_PROMPT",
      exports,
      ...(workerWorkdir ? [`cd ${shellQuote(workerWorkdir)}`] : []),
      "exec ark run-agent-sdk",
      "",
    ].join("\n");

    log(`Launching claude-agent via ${provider.name} -> arkd /process/spawn (handle=${handle})`);

    // Run the provisioning lifecycle (compute-start / ensure-reachable /
    // flush-secrets / prepare-workspace / isolation-prepare) and spawn
    // the launcher via /process/spawn. ensure-reachable sets up the SSM
    // tunnel and stores arkd_local_forward_port on session.config -- we
    // can only resolve provider.getArkdUrl AFTER that step, so the
    // launcher write happens INSIDE launchOverride.
    const { resolveTargetAndHandle } = await import("../services/dispatch/target-resolver.js");
    const { runTargetLifecycle } = await import("../services/dispatch/target-lifecycle.js");
    const { target, handle: computeHandle } = await resolveTargetAndHandle(app, session);
    if (!target || !computeHandle) {
      return { ok: false, handle: "", message: "no compute target resolved for claude-agent dispatch" };
    }

    try {
      await runTargetLifecycle(
        app,
        session.id,
        target,
        computeHandle,
        {
          // tmuxName + launcherContent fields are inert here -- the launchOverride
          // below replaces the terminal step and ignores them. Kept on the
          // shape because LaunchOpts has them required for legacy tmux callers.
          tmuxName: handle,
          workdir: workerWorkdir ?? "",
          launcherContent,
          ports: [],
        },
        {
          prepareCtx: { workdir: workerWorkdir ?? "", onLog: log },
          workspace: {
            source: (session.config as { remoteRepo?: string } | null)?.remoteRepo ?? session.repo ?? null,
            remoteWorkdir: workerWorkdir,
          },
          placement: opts.placement,
          computeStatus: compute.status,
          launchOverride: async () => {
            // ensure-reachable has run by now -- session.config.arkd_local_forward_port
            // is set for remote dispatches. Re-fetch the session so getArkdUrl
            // sees the freshly-stored port.
            const refreshed = (await app.sessions.get(session.id)) ?? session;
            const arkdUrl = provider.getArkdUrl?.(compute, refreshed);
            if (!arkdUrl) {
              throw new Error(`provider '${provider.name}' has no getArkdUrl`);
            }
            logInfo("session", "claude-agent.launch: writing launcher", {
              sessionId: session.id,
              arkdUrl,
              launcherPath: workerLauncherPath,
              launcherBytes: launcherContent.length,
            });
            const { ArkdClient } = await import("../../arkd/index.js");
            const arkdClient = new ArkdClient(arkdUrl);
            // mkdir -p the session dir on the worker first; arkd /file/write
            // doesn't auto-create parents, and /tmp/ark-<sid> won't exist
            // until the launcher itself runs (chicken-and-egg).
            await arkdClient.mkdir({ path: workerSessionDir, recursive: true });
            await arkdClient.writeFile({ path: workerLauncherPath, content: launcherContent, mode: 0o755 });
            logInfo("session", "claude-agent.launch: launcher written", {
              sessionId: session.id,
              path: workerLauncherPath,
            });

            logInfo("session", "claude-agent.launch: invoking provider.spawnProcess", {
              sessionId: session.id,
              handle,
              cmd: `bash ${workerLauncherPath}`,
              workdir: workerWorkdir || "/tmp",
            });
            const t0 = Date.now();
            const res = await provider.spawnProcess!(compute, refreshed, {
              handle,
              cmd: "bash",
              args: [workerLauncherPath],
              workdir: workerWorkdir || "/tmp",
              logPath: workerLogPath,
            });
            log(`claude-agent spawned (handle=${handle}, pid=${res.pid})`);
            logInfo("session", "claude-agent.launch: spawned", {
              sessionId: session.id,
              handle,
              pid: res.pid,
              elapsedMs: Date.now() - t0,
            });
            return { kind: computeHandle.kind, name: computeHandle.name, sessionName: handle, meta: {} };
          },
        },
      );
    } catch (err: any) {
      const msg = `launch failed: ${err?.message ?? err}`;
      logError("session", `claude-agent.launch: ${msg}`, {
        sessionId: session.id,
        provider: provider.name,
        handle,
      });
      return { ok: false, handle: "", message: msg };
    }

    await app.sessions.update(session.id, { session_id: handle });
    logInfo("session", "claude-agent.launch: ready", { sessionId: session.id, handle });
    return { ok: true, handle };
  },

  async kill(_handle: string): Promise<void> {
    // Lifecycle goes through provider.killProcessByHandle / killAgent
    // which the SessionTerminator already calls directly. The handle-only
    // signature here has no provider context, so this is a no-op.
  },

  async terminate(_handle: string): Promise<void> {
    // Same rationale as kill -- provider methods are the canonical path.
  },

  async status(_handle: string): Promise<ExecutorStatus> {
    // Status comes from arkd via provider.statusProcessByHandle; the
    // status-poller calls that with the session row in hand. Returning
    // "running" here would be wrong (we have no session context); "idle"
    // signals "ask the provider".
    return { state: "idle" };
  },

  async probeStatus({ session, handle, compute, provider }) {
    // claude-agent runs as a Bun process spawned via arkd /process/spawn,
    // NOT in tmux. The default `provider.checkSession` would query
    // /agent/status (tmux has-session) and always return false for a
    // process-based handle, flipping the row to completed within ~3s of
    // launch (#435). Use /process/status, which kill(pid, 0)s the actual
    // PID arkd recorded at spawn time.
    if (!provider.statusProcessByHandle) {
      // Provider can't tell us about processes -- safest answer is
      // "still running" so we don't false-positive into completed.
      return { state: "running" };
    }
    const status = await provider.statusProcessByHandle(compute, session, handle);
    if (status.running) return { state: "running", pid: status.pid };
    if (typeof status.exitCode === "number") {
      return status.exitCode === 0
        ? { state: "completed", exitCode: status.exitCode }
        : { state: "failed", error: `process exited with code ${status.exitCode}` };
    }
    // No record of the handle on arkd at all -- treat as gone, but
    // distinguish from a clean exit so the poller's "completed -> ready
    // -> mediate" branch can still fire.
    return { state: "not_found" };
  },

  async send(_handle: string, _message: string): Promise<void> {
    // Legacy handle-based send is meaningless for claude-agent (no stdin
    // surface). Conductor calls sendUserMessage() below for live steers,
    // which routes via arkd's `user-input` channel into the SDK's
    // PromptQueue.
  },

  async sendUserMessage({ app, session, message }) {
    if (!session.session_id) {
      logWarn("session", "claude-agent.sendUserMessage: no active session", { sessionId: session.id });
      return { ok: false, message: "session has no active agent" };
    }
    const tenantApp = session.tenant_id ? app.forTenant(session.tenant_id) : app;
    const { provider, compute } = await tenantApp.resolveProvider(session);
    if (!provider?.sendUserMessage || !compute) {
      const msg = "claude-agent has no reachable arkd-backed provider for this session";
      logError("session", `claude-agent.sendUserMessage: ${msg}`, {
        sessionId: session.id,
        providerName: provider?.name,
        hasSendUserMessage: !!provider?.sendUserMessage,
      });
      return { ok: false, message: msg };
    }
    try {
      const t0 = Date.now();
      await provider.sendUserMessage(compute, session, message);
      logInfo("session", "claude-agent.sendUserMessage: published to user-input channel", {
        sessionId: session.id,
        provider: provider.name,
        bytes: message.length,
        elapsedMs: Date.now() - t0,
      });
      return { ok: true, message: "Delivered" };
    } catch (e: any) {
      logError("session", `claude-agent.sendUserMessage: publish failed: ${e?.message ?? e}`, {
        sessionId: session.id,
        provider: provider.name,
      });
      return { ok: false, message: `user-message publish failed: ${e?.message ?? e}` };
    }
  },

  async capture(_handle: string, _lines = 80): Promise<string> {
    // Capture deferred to provider.captureOutput at the call site
    // (services/session-output.ts:getOutput already does this).
    return "";
  },
};
