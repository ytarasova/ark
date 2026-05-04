/**
 * Inline sub-stage dispatch helper.
 *
 * Used by ForEachDispatcher in `mode:inline` to run a sub-stage against the
 * parent session's worktree without changing `session.stage`. Unlike the main
 * dispatch path:
 *   - Task is already template-substituted (passed as subStage.task directly).
 *   - No buildTask / knowledge inject / repo-map overhead.
 *   - Launch, then poll until the agent process reaches a terminal state, then
 *     restore the parent session to "ready" so the loop can continue.
 */

import type { DispatchDeps, DispatchResult } from "./types.js";
import type { AgentDefinition } from "../../agent/agent.js";
import type { StageDefinition } from "../../state/flow.js";
import type { StageSecretResolver } from "./secrets-resolve.js";
import { buildLaunchEnv, launchAgent } from "./launch.js";
import { sessionAsVars } from "../task-builder.js";
import { logInfo, logWarn } from "../../observability/structured-log.js";

const INLINE_POLL_MS = 250;
const INLINE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Poll an executor until it reaches a terminal state (completed / failed /
 * not_found) or the deadline elapses. Exported for unit tests.
 *
 * - `running` / `idle`        -> keep polling.
 * - `completed`               -> { agentOk: true, agentExitOk: true }
 * - `failed`                  -> { agentOk: true, agentExitOk: false }
 * - `not_found`               -> { agentOk: true, agentExitOk: false }
 *     (executor has no record of the handle -- a real failure mode; was
 *      previously treated as success and silently swallowed.)
 * - deadline elapsed          -> { agentOk: false, agentExitOk: true }
 */
export async function pollInlineExecutorUntilTerminal(
  executor: { status(handle: string): Promise<{ state: string; [k: string]: unknown }> },
  handle: string,
  opts: { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ agentOk: boolean; agentExitOk: boolean }> {
  const pollMs = opts.pollMs ?? INLINE_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? INLINE_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));

  const deadline = Date.now() + timeoutMs;
  let agentOk = false;
  let agentExitOk = true;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const status = await executor.status(handle);
    if (status.state === "running" || status.state === "idle") continue;
    // Terminal: completed / failed / not_found
    agentOk = true;
    if (status.state === "failed") agentExitOk = false;
    if (status.state === "not_found") {
      // not_found means the executor has no record of the handle -- this is a
      // real failure mode (handle never registered, or was cleaned up before
      // we could observe a terminal state). Don't paper over it as success.
      agentExitOk = false;
      logWarn("session", "inline-substage executor.status returned not_found -- treating as failed");
    }
    break;
  }
  return { agentOk, agentExitOk };
}

export async function dispatchInlineSubStage(
  deps: Pick<
    DispatchDeps,
    | "sessions"
    | "events"
    | "computes"
    | "getApp"
    | "resolveAgent"
    | "resolveExecutor"
    | "buildClaudeArgs"
    | "materializeClaudeAuth"
    | "runtimes"
  >,
  secrets: StageSecretResolver,
  sessionId: string,
  subStage: StageDefinition,
  _iterVars: Record<string, string>,
): Promise<DispatchResult> {
  const log = (msg: string) => logInfo("session", `[inline-substage] ${msg}`);
  const session = await deps.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const agentRef = subStage.agent;
  if (!agentRef) {
    return { ok: false, message: `Inline sub-stage '${subStage.name}' has no agent` };
  }

  const { findProjectRoot, buildInlineAgent } = await import("../../agent/agent.js");
  const projectRoot = findProjectRoot(session.workdir || session.repo) ?? undefined;

  let agent: AgentDefinition | null = null;
  let agentName: string;

  if (typeof agentRef === "object" && agentRef !== null) {
    agent = buildInlineAgent(deps.getApp(), agentRef, sessionAsVars(session));
    agentName = agent?.name ?? "inline";
    if (!agent) return { ok: false, message: `Inline agent build failed for sub-stage '${subStage.name}'` };
  } else {
    // Preserve original inline-sub-stage behaviour: single lookup against the
    // session's projectRoot; no server-cwd fallback (main dispatch() has it,
    // inline dispatch historically did not -- keep parity).
    agentName = agentRef;
    agent = deps.resolveAgent(agentName, sessionAsVars(session), { projectRoot }) as AgentDefinition | null;
    if (!agent) return { ok: false, message: `Agent '${agentName}' not found for sub-stage '${subStage.name}'` };
  }

  const autonomy = subStage.autonomy ?? "full";
  // Stage-level model override (legacy subStage.model) still applies.
  if (subStage.model) agent.model = subStage.model;

  // Task: use the already-substituted subStage.task, or fall back to session summary.
  const task = subStage.task ?? session.summary ?? "";

  const runtime = agent._resolved_runtime_type ?? agent.runtime;
  if (!runtime) {
    return {
      ok: false,
      message: `No runtime resolvable for inline sub-stage '${subStage.name}' (agent '${agentName}' has no runtime field)`,
    };
  }
  const executor = deps.resolveExecutor(runtime);
  if (!executor) return { ok: false, message: `Executor '${runtime}' not registered` };

  const claudeArgs = runtime === "claude-code" ? deps.buildClaudeArgs(agent, { autonomy, projectRoot }) : [];

  const launchEnv = await buildLaunchEnv(deps, secrets, session, subStage, runtime, log);
  if (launchEnv.error) return { ok: false, message: launchEnv.error };

  await deps.events.log(sessionId, "prompt_sent", {
    stage: session.stage,
    actor: "orchestrator",
    data: {
      agent: agentName,
      sub_stage: subStage.name,
      task_preview: task.slice(0, 500),
      task_length: task.length,
      task_full: task,
    },
  });

  const launchResult = await launchAgent(deps, executor, {
    sessionId,
    session,
    agent,
    task,
    claudeArgs,
    env: launchEnv.env,
    stage: subStage.name,
    autonomy,
    log,
    prevClaudeSessionId: undefined, // Inline sub-stages always start fresh
    sessionName: `${session.summary ?? session.id} / ${subStage.name}`,
    initialPrompt: task.slice(0, 2000),
    placement: launchEnv.placement,
  });

  if (!launchResult.ok) return { ok: false, message: launchResult.message ?? "Launch failed" };
  const tmuxName = launchResult.handle;

  // Mark parent session as running while this sub-stage executes.
  await deps.sessions.update(sessionId, { status: "running", session_id: tmuxName, agent: agentName });

  await deps.events.log(sessionId, "stage_started", {
    stage: session.stage,
    actor: "system",
    data: { sub_stage: subStage.name, agent: agentName, session_id: tmuxName, model: agent.model },
  });

  // Poll until the agent process reaches a terminal state. Uses the
  // executor's polymorphic status() interface rather than probing tmux
  // directly -- agent-sdk (and other tmux-less runtimes) launch plain
  // processes, so a tmux `has-session` check would falsely report the
  // agent done on the first poll. executor.status(handle) returns
  // "running"/"idle" while alive, "completed"/"failed" after exit, and
  // "not_found" if the executor has no record (now treated as failed --
  // see pollInlineExecutorUntilTerminal).
  const { agentOk, agentExitOk } = await pollInlineExecutorUntilTerminal(executor, tmuxName);

  // Restore parent session to ready so the inline loop can continue.
  await deps.sessions.update(sessionId, { status: "ready", session_id: null });

  if (!agentOk) {
    return { ok: false, message: `Inline sub-stage '${subStage.name}' timed out after 30 minutes` };
  }
  if (!agentExitOk) {
    return { ok: false, message: `Inline sub-stage '${subStage.name}' agent exited with error` };
  }

  return {
    ok: true,
    launched: false,
    reason: "inline_substage_complete",
    message: `sub-stage '${subStage.name}' complete`,
  };
}
