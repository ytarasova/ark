/**
 * Post-launch persistence + side-effects.
 *
 * After executor.launch() returns ok, this module:
 *   1. Persists launch PID + executor name + timestamp (best-effort).
 *   2. Captures HEAD sha for per-stage commit verification (best-effort).
 *   3. Guards against a stage-change race mid-dispatch -- if the session
 *      was force-advanced or completed while the launcher was spinning up,
 *      we kill the tmux handle and abort before clobbering its state.
 *   4. Writes `running` status + session_id + (optional) rework clear.
 *   5. Emits stage_started event, persists flow_states current stage.
 *   6. Checkpoints the session, starts the crash-detection status poller,
 *      records observability + telemetry.
 *
 * Any step that can legitimately fail in odd environments (git missing,
 * flow-states write, poller start) is wrapped in try/catch -- we never
 * unwind a successful launch on a best-effort failure.
 */

import { execFileSync } from "child_process";

import { logWarn } from "../../observability/structured-log.js";
import { recordEvent } from "../../observability.js";
import { track } from "../../observability/telemetry.js";
import type { DispatchDeps, DispatchResult } from "./types.js";
import type { AgentDefinition } from "../../agent/agent.js";
import type { Session } from "../../../types/index.js";

export interface PostLaunchOpts {
  session: Session;
  agent: AgentDefinition;
  agentName: string;
  stage: string;
  runtime: string;
  tmuxName: string;
  launchPid?: number;
  reworkPromptCleared: boolean;
  taskPreview: string;
  log: (msg: string) => void;
}

/**
 * Finalise a successful launch. Returns a DispatchResult:
 *   - { ok: true, message: tmuxName } on success.
 *   - { ok: false, message } when the stage-change race fires (launcher killed).
 */
export async function finalizeLaunch(
  deps: Pick<DispatchDeps, "sessions" | "events" | "flowStates" | "launcher" | "checkpoint" | "startStatusPoller">,
  opts: PostLaunchOpts,
): Promise<DispatchResult> {
  const { session, agent, agentName, stage, runtime, tmuxName, launchPid, log, reworkPromptCleared, taskPreview } =
    opts;
  const sessionId = session.id;

  // Persist runtime kind + launch metadata. launch_executor MUST land for
  // every successful dispatch (it's how session.send() picks the right
  // transport on subsequent steers); previously this was gated on
  // `launchPid`, which arkd-backed launches don't return -- so EC2 / k8s
  // sessions ended up with launch_executor=null and steers fell through
  // to the claude-code/tmux path even though the agent ran claude-agent.
  await deps.sessions.mergeConfig(sessionId, {
    ...(launchPid ? { launch_pid: launchPid } : {}),
    launch_executor: runtime,
    launched_at: new Date().toISOString(),
  });

  // Record HEAD sha at stage start for per-stage commit verification
  let stageStartSha: string | undefined;
  if (session.workdir) {
    try {
      stageStartSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: session.workdir,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
    } catch (err: any) {
      // no git -- skip
      logWarn("session", `no git -- skip: ${err?.message ?? err}`);
    }
  }

  // Guard against a race: if the session was force-advanced (or stopped /
  // completed) while we were spinning up the launcher, don't stomp its
  // current status/session_id with "running" for a stage that no longer
  // belongs to it.
  const currentSession = await deps.sessions.get(sessionId);
  if (!currentSession || currentSession.stage !== stage || currentSession.status === "completed") {
    log(`Session moved past stage '${stage}' during dispatch -- aborting write.`);
    try {
      await deps.launcher.kill(tmuxName);
    } catch (err: any) {
      // tmux may already be gone
      logWarn("session", `tmux may already be gone: ${err?.message ?? err}`);
    }
    return { ok: false, message: `Session moved on during dispatch` };
  }

  await deps.sessions.update(sessionId, {
    status: "running",
    agent: agentName,
    session_id: tmuxName,
    // Single-shot rework prompt: clear now that it has been delivered.
    ...(reworkPromptCleared ? { rework_prompt: null } : {}),
  });
  if (stageStartSha) {
    await deps.sessions.mergeConfig(sessionId, { stage_start_sha: stageStartSha });
  }
  await deps.events.log(sessionId, "stage_started", {
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
    await deps.flowStates.setCurrentStage(sessionId, session.stage!, session.flow);
  } catch (err: any) {
    // skip flow-state on error
    logWarn("session", `skip flow-state on error: ${err?.message ?? err}`);
  }

  // Checkpoint after successful dispatch
  deps.checkpoint(sessionId);

  // Start status poller for ALL runtimes as a crash detection fallback.
  // Claude uses hook-based status but hooks don't fire when the agent crashes
  // (e.g. MCP config error, OOM, segfault). The poller detects tmux session exit.
  try {
    deps.startStatusPoller(sessionId, tmuxName, runtime);
  } catch (err: any) {
    // status poller is best-effort -- agent runs fine without it
    logWarn("session", `status poller is best-effort -- agent runs fine without it: ${err?.message ?? err}`);
  }

  // Observability + telemetry
  recordEvent({
    type: "session_start",
    sessionId,
    data: { agent: session.agent ?? agentName, flow: session.flow },
  });
  track("session_dispatched", { agent: agentName });

  return { ok: true, launched: true, message: tmuxName };
}
