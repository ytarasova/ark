/**
 * Core dispatch loop: resolve -> validate -> launch -> persist.
 *
 * The heavy lifting lives in sibling modules; this file is now a thin
 * coordinator that sequences them:
 *
 *   guards.ts          validateSessionForDispatch, maybeHandleActionStage,
 *                       cloneRemoteRepoIfNeeded, checkPromptInjection
 *   compute-resolve.ts ComputeResolver (per-stage template clone)
 *   secrets-resolve.ts StageSecretResolver (stage + runtime secret merge)
 *   dispatch-hosted.ts HostedDispatcher (hosted-mode scheduler takes precedence)
 *   dispatch-fanout.ts FanOutDispatcher (fork stages)
 *   dispatch-foreach.ts ForEachDispatcher (for_each + mode:{spawn,inline})
 *   agent-resolve.ts   resolveDispatchAgent, applyStageModelAndResolveSlug
 *   task-assembly.ts   assembleTask (buildTask + inject + rework prompt)
 *   launch.ts          buildLaunchEnv, launchAgent
 *   post-launch.ts     finalizeLaunch (persist run state + poller + telemetry)
 *   inline-substage.ts dispatchInlineSubStage (for_each mode:inline sub-stages)
 *
 * Resume: tear down any running tmux, clear transient status fields, call
 * dispatch again.
 *
 * ── ComputeTarget migration call chart ─────────────────────────────────────
 *
 * The dispatch path today still consumes the legacy `ComputeProvider`
 * interface. Plan to flip onto `ComputeTarget` (Compute × Isolation
 * composition) is in
 * `docs/superpowers/plans/2026-05-01-compute-target-dispatch-flip-plan.md`.
 *
 * | Today (legacy `provider`)        | After flip (`target`)              |
 * |----------------------------------|------------------------------------|
 * | `provider.start(compute)`        | `target.compute.start(handle)`     |
 * | `provider.prepareForLaunch(...)` | `target.prepare(handle, ctx)`      |
 * | `applyContainerSetup(...)`       | covered by `target.prepare`        |
 * | `provider.launch(c, s, opts)`    | `target.launchAgent(handle, opts)` |
 * | `provider.killAgent(c, s)`       | arkd-side via `client.kill`        |
 * | `provider.cleanupSession(c, s)`  | `target.shutdown(handle)`          |
 * | `provider.captureOutput(c, s)`   | arkd `/agent/capture`              |
 * | `provider.getArkdUrl(c)`         | `target.getArkdUrl(handle)`        |
 *
 * The new helpers `resolveTargetAndHandle` and `runTargetLifecycle`
 * (added in tasks 2 + 3 of the plan) wrap the lifecycle in
 * `provisionStep` so each phase emits structured events. Compute
 * provisioning is pool-aware via `ComputeTarget.provision`.
 */

import type { DispatchDeps, DispatchResult } from "./types.js";
import type { StageDefinition } from "../../state/flow.js";

import { ComputeResolver } from "./compute-resolve.js";
import { StageSecretResolver } from "./secrets-resolve.js";
import { HostedDispatcher } from "./dispatch-hosted.js";
import { FanOutDispatcher } from "./dispatch-fanout.js";
import { ForEachDispatcher } from "./dispatch-foreach.js";
import type { DispatchInlineSubStageCb } from "./dispatch-foreach.js";
import { buildSessionVars } from "../../template.js";

import {
  validateSessionForDispatch,
  maybeHandleActionStage,
  cloneRemoteRepoIfNeeded,
  checkPromptInjection,
} from "./guards.js";
import { resolveDispatchAgent, applyStageModelAndResolveSlug } from "./agent-resolve.js";
import { assembleTask } from "./task-assembly.js";
import { buildLaunchEnv, launchAgent } from "./launch.js";
import { finalizeLaunch } from "./post-launch.js";
import { dispatchInlineSubStage } from "./inline-substage.js";

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
    this.foreach = new ForEachDispatcher({
      ...deps,
      dispatchInlineSubStage: ((sessionId, subStage, iterVars) =>
        dispatchInlineSubStage(this.deps, this.secrets, sessionId, subStage, iterVars)) as DispatchInlineSubStageCb,
    });
  }

  /** Expose compute resolution so callers needing just that path can avoid launching. */
  resolveComputeForStage(
    stageDef: StageDefinition | null,
    sessionId: string,
    log: (msg: string) => void = () => {},
  ): Promise<string | null> {
    return this.compute.resolveForStage(stageDef, sessionId, log);
  }

  async dispatch(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<DispatchResult> {
    const log = opts?.onLog ?? (() => {});

    // 1. Load + validate session preconditions.
    const validated = await validateSessionForDispatch(this.deps, sessionId);
    if (validated.early) return validated.early;
    const session = validated.session;
    const stage = session.stage!;

    // 2. Action stages short-circuit ahead of the hosted path so single-action
    // flows can auto-complete on the control plane without a worker.
    const actionResult = await maybeHandleActionStage(this.deps, session);
    if (actionResult) return actionResult;

    // 3. Hosted mode takes precedence; falls through in local mode.
    const hosted = await this.hosted.dispatch(sessionId, session, log);
    if (hosted) return hosted;

    // 4. Clone remote repo if the session references one and no workdir yet.
    const cloned = await cloneRemoteRepoIfNeeded(this.deps, session, log);
    if (cloned.ok === false) return { ok: false, message: cloned.message };

    // 5. Prompt-injection guard on session.summary.
    const guard = await checkPromptInjection(this.deps, session);
    if (guard.blocked) return { ok: false, message: guard.message! };

    // 6. Per-stage compute template override.
    const stageDef = this.deps.getStage(session.flow, stage);
    const stageCompute = await this.compute.resolveForStage(stageDef, sessionId, log);
    if (stageCompute) {
      await this.deps.sessions.update(sessionId, { compute_name: stageCompute });
      (session as { compute_name: string | null }).compute_name = stageCompute;
    }

    // 7. Fork stage -> FanOutDispatcher.
    if (stageDef?.type === "fork") {
      return this.fanout.dispatchFork(sessionId, stageDef);
    }

    // 8. for_each -> ForEachDispatcher (spawn or inline mode).
    if (stageDef?.for_each !== undefined) {
      const sessionVars = buildSessionVars(session as unknown as Record<string, unknown>);
      const result = await this.foreach.dispatchForEach(sessionId, stageDef, sessionVars);
      if (result.ok) {
        await this.deps.mediateStageHandoff(sessionId, { autoDispatch: true, source: "dispatch_for_each" });
      } else {
        await this.deps.sessions.update(sessionId, {
          status: "failed",
          error: result.message.slice(0, 500),
        });
      }
      return result;
    }

    // 9. Agent stage. Must come last -- all shorter-circuit paths above
    // consumed the dispatch if they applied.
    const action = this.deps.getStageAction(session.flow, stage);
    if (action.type !== "agent") {
      return { ok: false, message: `Stage '${stage}' is ${action.type}, not agent` };
    }

    const { findProjectRoot } = await import("../../agent/agent.js");
    const projectRoot = findProjectRoot(session.workdir || session.repo) ?? undefined;

    // Resolve agent (inline spec or named) + apply stage model override + catalog slug.
    const agentResolution = await resolveDispatchAgent(this.deps, session, action.agent, projectRoot, log);
    if (!agentResolution.ok) return { ok: false, message: agentResolution.message };
    const { agent, agentName } = agentResolution.resolved;
    applyStageModelAndResolveSlug(this.deps, agent, stageDef, projectRoot, log);

    const autonomy = stageDef?.autonomy ?? "full";

    // Build task (with handoff context, knowledge, repo-map, rework prompt).
    const { task, taskPreview } = await assembleTask(this.deps, session, stage, agentName, log);

    // Two distinct identifiers, do not conflate:
    //   - runtimeType: dispatch the right executor (claude-code, agent-sdk,
    //     cli-agent, ...). Comes from the runtime YAML's `type` field.
    //   - runtimeName: lookup key into RuntimeStore for `secrets:`,
    //     `mcp_servers`, env, etc. Comes from the agent YAML's
    //     `runtime: <name>` (which references runtimes/<name>.yaml).
    //
    // The previous code passed runtimeType to both executor resolution AND
    // secrets resolution. Type and name happen to match for `agent-sdk`
    // (name=agent-sdk, type=agent-sdk) so its declared secrets resolved.
    // For claude (name=claude, type=claude-code) the secrets resolver did
    // `runtimes.get("claude-code")` -> null -> ANTHROPIC_API_KEY never made
    // it into the launch env even though runtimes/claude.yaml declares it.
    const runtimeType = agent._resolved_runtime_type ?? agent.runtime ?? "claude-code";
    const runtimeName = agent.runtime ?? runtimeType;
    const executor = this.deps.resolveExecutor(runtimeType);
    if (!executor) return { ok: false, message: `Executor '${runtimeType}' not registered` };

    // Build claude args (only for claude-code executor)
    const claudeArgs = runtimeType === "claude-code" ? this.deps.buildClaudeArgs(agent, { autonomy, projectRoot }) : [];

    // Assemble launch env: stage/runtime secrets + tenant claude auth.
    const launchEnv = await buildLaunchEnv(this.deps, this.secrets, session, stageDef, runtimeName, log);
    if (launchEnv.error) return { ok: false, message: launchEnv.error };

    // Launch via executor.
    log(`Launching via ${runtimeType} (runtime '${runtimeName}')...`);
    const launchResult = await launchAgent(this.deps, executor, {
      sessionId,
      session,
      agent,
      task,
      claudeArgs,
      env: launchEnv.env,
      stage,
      autonomy,
      log,
      prevClaudeSessionId: session.claude_session_id,
      sessionName: session.summary ?? session.id,
      // Pass only the summary as the CLI positional arg (initial user message).
      // The full context-injected task is too large for ARG_MAX; it goes via
      // system prompt + channel delivery instead.
      initialPrompt: session.summary ?? task.slice(0, 2000),
      // Forward the deferred PlacementCtx so the executor can hand it to
      // `runTargetLifecycle` -- the `flush-secrets` step delivers the
      // queued file ops via the compute's medium-specific transport.
      placement: launchEnv.placement,
    });
    if (!launchResult.ok) return { ok: false, message: launchResult.message ?? "Launch failed" };

    // Post-launch persistence (race guard + run-state write + poller + telemetry).
    return finalizeLaunch(this.deps, {
      session,
      agent,
      agentName,
      stage,
      runtime: runtimeType,
      tmuxName: launchResult.handle,
      launchPid: launchResult.pid,
      reworkPromptCleared: Boolean(session.rework_prompt),
      taskPreview,
      log,
    });
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
}
