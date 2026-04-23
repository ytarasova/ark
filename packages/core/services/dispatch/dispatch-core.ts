/**
 * Core dispatch loop: resolve -> validate -> launch -> persist.
 *
 * Flow:
 *   1. Load + validate session state (status, stage, compute existence).
 *   2. Short-circuit `action:` stages (execute in-process, no agent launch).
 *   3. Hosted-mode scheduling takes precedence; falls through in local mode.
 *   4. Clone remote repo if `config.remoteRepo` + no workdir.
 *   5. Prompt-injection guard on session.summary.
 *   6. Per-stage compute override resolution (template clone path).
 *   7. Fork branch dispatches via `FanOutDispatcher`.
 *   8. for_each + mode:spawn iterates a list and spawns one child per item.
 *   9. Agent stage: resolve agent -> build task -> inject context/repo-map
 *      -> resolve secrets + tenant claude auth -> launch via executor.
 *  10. Post-launch: guard against mid-dispatch stage-change race, persist
 *      run state, log stage_started, checkpoint, start status poller.
 *
 * Resume: tear down any running tmux, clear transient status fields, call
 * dispatch again.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { promisify } from "util";
import { execFile } from "child_process";

import type { DispatchDeps, DispatchResult } from "./types.js";
import type { Session } from "../../../types/index.js";
import { logDebug } from "../../observability/structured-log.js";
import { recordEvent } from "../../observability.js";
import { track } from "../../observability/telemetry.js";
import { detectInjection } from "../../session/prompt-guard.js";
import { sessionAsVars } from "../task-builder.js";

import { ComputeResolver } from "./compute-resolve.js";
import { StageSecretResolver } from "./secrets-resolve.js";
import { HostedDispatcher } from "./dispatch-hosted.js";
import { FanOutDispatcher } from "./dispatch-fanout.js";
import { ForEachDispatcher } from "./dispatch-foreach.js";
import { buildSessionVars } from "../../template.js";

const execFileAsync = promisify(execFile);

export class CoreDispatcher {
  private readonly compute: ComputeResolver;
  private readonly secrets: StageSecretResolver;
  private readonly hosted: HostedDispatcher;
  private readonly fanout: FanOutDispatcher;
  private readonly foreach: ForEachDispatcher;

  constructor(private readonly deps: DispatchDeps) {
    this.compute = new ComputeResolver(deps);
    this.secrets = new StageSecretResolver(deps);
    this.hosted = new HostedDispatcher(deps);
    this.fanout = new FanOutDispatcher(deps);
    this.foreach = new ForEachDispatcher(deps);
  }

  /** Expose compute resolution so callers needing just that path can avoid launching. */
  resolveComputeForStage(
    stageDef: import("../../state/flow.js").StageDefinition | null,
    sessionId: string,
    log: (msg: string) => void = () => {},
  ): Promise<string | null> {
    return this.compute.resolveForStage(stageDef, sessionId, log);
  }

  async dispatch(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<DispatchResult> {
    const log = opts?.onLog ?? (() => {});
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    if (session.status === "running" && session.session_id) {
      return { ok: true, message: `Already running (${session.session_id})` };
    }
    if (session.status !== "ready" && session.status !== "blocked") {
      return {
        ok: false,
        message: `Not ready (status: ${session.status}). Stop it first, or wait for it to finish.`,
      };
    }

    const stage = session.stage;
    if (!stage) return { ok: false, message: "No current stage. The session may have completed its flow." };

    // Validate compute exists if specified
    if (session.compute_name && !(await this.deps.computes.get(session.compute_name))) {
      return {
        ok: false,
        message: `Compute '${session.compute_name}' not found. Delete and recreate the session.`,
      };
    }

    // Action stages execute in-process regardless of hosted/local mode -- they
    // don't launch an agent, don't need an arkd worker, and must not be
    // scheduled like one. Handle them here before the hosted scheduler path
    // so single-action flows can auto-complete on the control plane without
    // waiting on a worker that will never have anything to do.
    const earlyAction = this.deps.getStageAction(session.flow, stage);
    if (earlyAction.type === "action") {
      const result = await this.deps.executeAction(sessionId, earlyAction.action ?? "");
      if (!result.ok) {
        await this.deps.sessions.update(sessionId, {
          status: "failed",
          error: `Action '${earlyAction.action}' failed: ${result.message.slice(0, 200)}`,
        });
        return { ok: false, message: result.message };
      }
      const postAction = await this.deps.sessions.get(sessionId);
      if (postAction?.status === "ready") {
        await this.deps.mediateStageHandoff(sessionId, { autoDispatch: true, source: "dispatch_action" });
      }
      return { ok: true, message: `Executed action '${earlyAction.action}'` };
    }

    // Hosted mode takes precedence; local dispatch runs only if no scheduler is wired.
    const hosted = await this.hosted.dispatch(sessionId, session, log);
    if (hosted) return hosted;

    const cloned = await this.cloneRemoteRepoIfNeeded(sessionId, session, log);
    if (cloned.ok === false) return { ok: false, message: cloned.message };

    // Check task summary for prompt injection
    try {
      const injection = detectInjection(session.summary ?? "");
      if (injection.severity === "high") {
        await this.deps.events.log(sessionId, "prompt_injection_blocked", {
          actor: "system",
          data: { patterns: injection.patterns, context: "dispatch" },
        });
        return { ok: false, message: "Dispatch blocked: potential prompt injection in task summary" };
      }
      if (injection.detected) {
        await this.deps.events.log(sessionId, "prompt_injection_warning", {
          actor: "system",
          data: { patterns: injection.patterns, severity: injection.severity, context: "dispatch" },
        });
      }
    } catch {
      logDebug("session", "skip guard on error");
    }

    // Check if fork stage
    const stageDef = this.deps.getStage(session.flow, stage);

    // Resolve per-stage compute template override
    const stageCompute = await this.compute.resolveForStage(stageDef, sessionId, log);
    if (stageCompute) {
      await this.deps.sessions.update(sessionId, { compute_name: stageCompute });
      (session as { compute_name: string | null }).compute_name = stageCompute;
    }

    if (stageDef?.type === "fork") {
      return this.fanout.dispatchFork(sessionId, stageDef);
    }

    // for_each + mode:spawn: iterate a list and spawn one child per item sequentially.
    if (stageDef?.for_each !== undefined) {
      const sessionVars = buildSessionVars(session as unknown as Record<string, unknown>);
      const result = await this.foreach.dispatchForEach(sessionId, stageDef, sessionVars);
      if (result.ok) {
        // Stage is complete -- mediate handoff to the next stage.
        await this.deps.mediateStageHandoff(sessionId, { autoDispatch: true, source: "dispatch_for_each" });
      } else {
        await this.deps.sessions.update(sessionId, {
          status: "failed",
          error: result.message.slice(0, 500),
        });
      }
      return result;
    }

    const action = this.deps.getStageAction(session.flow, stage);
    if (action.type !== "agent") {
      return { ok: false, message: `Stage '${stage}' is ${action.type}, not agent` };
    }

    const agentName = action.agent!;
    log(`Resolving agent: ${agentName}`);
    // Resolve runtime override from session config (set by --runtime CLI flag)
    const runtimeOverride = session.config?.runtime_override as string | undefined;
    const { findProjectRoot } = await import("../../agent/agent.js");
    const projectRoot = findProjectRoot(session.workdir || session.repo) ?? undefined;
    let agent = this.deps.resolveAgent(agentName, sessionAsVars(session), { runtimeOverride, projectRoot });
    // Fallback: agents created via the web UI are saved relative to the server's
    // cwd which may differ from the session's workdir/repo.
    if (!agent) {
      const serverRoot = findProjectRoot(process.cwd()) ?? undefined;
      if (serverRoot && serverRoot !== projectRoot) {
        agent = this.deps.resolveAgent(agentName, sessionAsVars(session), {
          runtimeOverride,
          projectRoot: serverRoot,
        });
      }
    }
    if (!agent) return { ok: false, message: `Agent '${agentName}' not found` };

    // Resolve autonomy level from flow stage definition
    const autonomy = stageDef?.autonomy ?? "full";

    // Check for stage-level or session-level model override
    const modelOverride = stageDef?.model ?? (session.config?.model_override as string | undefined);
    if (modelOverride) {
      agent.model = modelOverride;
    }

    // Build task with handoff context
    log("Building task...");
    let task = await this.deps.buildTask(session, stage, agentName);
    // Capture clean user task before context/repo-map injection for event previews
    const taskPreview = (session.summary || task.slice(0, 200)).slice(0, 200);

    // Index codebase into knowledge graph (remote arkd for hosted, local otherwise).
    await this.deps.indexRepo(session, log);

    // Inject knowledge-graph context + repo map above/below the task.
    task = await this.deps.injectKnowledge(session, task);
    task = this.deps.injectRepoMap(session, task);

    // Append rework prompt (set by gate/reject). Single-shot: cleared after a
    // successful launch so subsequent dispatches of the same stage don't replay
    // stale rework instructions.
    const reworkPrompt = session.rework_prompt;
    if (reworkPrompt) {
      task += `\n\n## Rework requested\n\n${reworkPrompt}`;
      log(`Appended rework prompt (rejection #${session.rejection_count ?? 0})`);
    }

    // Log the fully assembled prompt for audit trail
    await this.deps.events.log(sessionId, "prompt_sent", {
      stage,
      actor: "orchestrator",
      data: {
        agent: agentName,
        task_preview: task.slice(0, 500),
        task_length: task.length,
        task_full: task,
      },
    });

    // Resolve executor -- use resolved runtime type (from RuntimeStore merge),
    // fall back to agent.runtime, then claude-code.
    const runtime = agent._resolved_runtime_type ?? agent.runtime ?? "claude-code";
    const executor = this.deps.resolveExecutor(runtime);
    if (!executor) return { ok: false, message: `Executor '${runtime}' not registered` };

    // Build claude args (only for claude-code executor)
    const claudeArgs = runtime === "claude-code" ? this.deps.buildClaudeArgs(agent, { autonomy, projectRoot }) : [];

    // Resolve secrets declared on the stage + the runtime and merge them
    // into the launch env. Stage secrets win over runtime secrets on name
    // conflict. A missing secret fails dispatch with a clear message --
    // we never silently drop an env var the agent depends on.
    const secretEnv = await this.secrets.resolve(session, stageDef, runtime, log);
    if (secretEnv.error) return { ok: false, message: secretEnv.error };

    // Tenant-level claude auth materialization. Runs BEFORE we read the
    // compute row for launch so any `credsSecretName` mutation lands before
    // the provider sees it.
    const computeForAuth = session.compute_name ? await this.deps.computes.get(session.compute_name) : null;
    const claudeAuth = await this.deps.materializeClaudeAuth(session, computeForAuth);
    if (Object.keys(claudeAuth.env).length > 0) {
      log(`Injected tenant-level claude auth env: ${Object.keys(claudeAuth.env).join(", ")}`);
    }
    if (claudeAuth.credsSecretName) {
      log(`Materialized subscription blob as k8s Secret '${claudeAuth.credsSecretName}'`);
    }

    // Merge launch env. Order: stage/runtime secrets first, tenant auth
    // second -- we WANT the tenant's ANTHROPIC_API_KEY to win when an
    // operator configured it, so sessions that don't declare their own
    // secret still get auth.
    const launchEnv: Record<string, string> = { ...secretEnv.env, ...claudeAuth.env };

    // Launch via executor
    log(`Launching via ${runtime}...`);
    const launchResult = await executor.launch({
      sessionId,
      workdir: session.workdir ?? session.repo,
      agent: agent as any,
      task,
      claudeArgs,
      env: launchEnv,
      stage,
      autonomy,
      onLog: log,
      prevClaudeSessionId: session.claude_session_id,
      sessionName: session.summary ?? session.id,
      // Pass only the summary as the CLI positional arg (initial user message).
      // The full context-injected task is too large for ARG_MAX; it goes via
      // system prompt + channel delivery instead.
      initialPrompt: session.summary ?? task.slice(0, 2000),
      compute: session.compute_name
        ? (((await this.deps.computes.get(session.compute_name)) as unknown as {
            name: string;
            provider: string;
            [k: string]: unknown;
          } | null) ?? undefined)
        : undefined,
      // LaunchOpts.app is still required by the executor interface; dispatch
      // is the sole reader of getApp() in this class. Refactoring executors
      // off AppContext is a separate migration.
      app: this.deps.getApp(),
    });

    if (!launchResult.ok) return { ok: false, message: launchResult.message ?? "Launch failed" };
    const tmuxName = launchResult.handle;

    // Persist launch PID for process-tree tracking
    if (launchResult.pid) {
      await this.deps.sessions.mergeConfig(sessionId, {
        launch_pid: launchResult.pid,
        launch_executor: runtime,
        launched_at: new Date().toISOString(),
      });
    }

    // Record HEAD sha at stage start for per-stage commit verification
    let stageStartSha: string | undefined;
    if (session.workdir) {
      try {
        stageStartSha = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: session.workdir,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
      } catch {
        logDebug("session", "no git -- skip");
      }
    }

    // Guard against a race: if the session was force-advanced (or stopped /
    // completed) while we were spinning up the launcher, don't stomp its
    // current status/session_id with "running" for a stage that no longer
    // belongs to it.
    const currentSession = await this.deps.sessions.get(sessionId);
    if (!currentSession || currentSession.stage !== stage || currentSession.status === "completed") {
      log(`Session moved past stage '${stage}' during dispatch -- aborting write.`);
      try {
        await this.deps.launcher.kill(tmuxName);
      } catch {
        logDebug("session", "tmux may already be gone");
      }
      return { ok: false, message: `Session moved on during dispatch` };
    }

    await this.deps.sessions.update(sessionId, {
      status: "running",
      agent: agentName,
      session_id: tmuxName,
      // Single-shot rework prompt: clear now that it has been delivered.
      ...(reworkPrompt ? { rework_prompt: null } : {}),
    });
    if (stageStartSha) {
      await this.deps.sessions.mergeConfig(sessionId, { stage_start_sha: stageStartSha });
    }
    await this.deps.events.log(sessionId, "stage_started", {
      stage,
      actor: "user",
      data: {
        agent: agentName,
        session_id: tmuxName,
        model: agent.model,
        tools: agent.tools,
        skills: agent.skills,
        memories: agent.memories,
        task_preview: taskPreview,
        stage_start_sha: stageStartSha,
      },
    });

    // Persist flow state: mark current stage
    try {
      await this.deps.flowStates.setCurrentStage(sessionId, session.stage!, session.flow);
    } catch {
      logDebug("session", "skip flow-state on error");
    }

    // Checkpoint after successful dispatch
    this.deps.checkpoint(sessionId);

    // Start status poller for ALL runtimes as a crash detection fallback.
    // Claude uses hook-based status but hooks don't fire when the agent crashes
    // (e.g. MCP config error, OOM, segfault). The poller detects tmux session exit.
    try {
      this.deps.startStatusPoller(sessionId, tmuxName, runtime);
    } catch {
      logDebug("session", "status poller is best-effort -- agent runs fine without it");
    }

    // Observability + telemetry
    recordEvent({
      type: "session_start",
      sessionId,
      data: { agent: session.agent ?? agentName, flow: session.flow },
    });
    track("session_dispatched", { agent: agentName });

    return { ok: true, message: tmuxName };
  }

  async resume(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<DispatchResult> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };
    if (session.status === "running" && session.session_id) return { ok: false, message: "Already running" };

    if (session.session_id) await this.deps.launcher.kill(session.session_id);

    await this.deps.sessions.update(sessionId, {
      status: "ready",
      error: null,
      breakpoint_reason: null,
      attached_by: null,
      session_id: null,
    });
    await this.deps.events.log(sessionId, "session_resumed", {
      stage: session.stage,
      actor: "user",
      data: { from_status: session.status },
    });

    // Auto re-dispatch
    return this.dispatch(sessionId, opts);
  }

  /** Clone a remote repo referenced in session.config.remoteRepo into the worktrees dir. */
  private async cloneRemoteRepoIfNeeded(
    sessionId: string,
    session: Session,
    log: (msg: string) => void,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!session.config?.remoteRepo || session.workdir) return { ok: true };
    const remoteUrl = session.config.remoteRepo as string;
    log(`Cloning remote repo: ${remoteUrl}`);
    try {
      const tmpDir = join(this.deps.config.arkDir, "worktrees", sessionId);
      mkdirSync(tmpDir, { recursive: true });
      await execFileAsync("git", ["clone", "--depth", "1", remoteUrl, tmpDir], { timeout: 120_000 });
      await this.deps.sessions.update(sessionId, { workdir: tmpDir });
      const updated = await this.deps.sessions.get(sessionId);
      if (updated) (session as { workdir: string | null }).workdir = updated.workdir;
      log(`Cloned remote repo to ${tmpDir}`);
      await this.deps.events.log(sessionId, "remote_repo_cloned", {
        actor: "system",
        data: { url: remoteUrl, dir: tmpDir },
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, message: `Failed to clone remote repo: ${e.message}` };
    }
  }
}
