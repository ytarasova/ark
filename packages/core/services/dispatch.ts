/**
 * Session dispatch -- resolve compute + launch the agent for the current stage.
 *
 * Extracted from stage-orchestrator.ts. `dispatch` is the main entry point;
 * `resume` re-dispatches after a kill; `resolveComputeForStage` handles
 * per-stage compute template overrides. Fork/fan-out paths delegate to
 * fork-join.ts via dynamic imports to avoid circular dependencies.
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);

import type { AppContext } from "../app.js";
import * as flow from "../state/flow.js";
import * as agentRegistry from "../agent/agent.js";
import { saveCheckpoint } from "../session/checkpoint.js";
import { logDebug } from "../observability/structured-log.js";
import { recordEvent } from "../observability.js";
import { track } from "../observability/telemetry.js";
import { detectInjection } from "../session/prompt-guard.js";
import { getExecutor } from "../executor.js";

import { sessionAsVars, buildTaskWithHandoff, extractSubtasks } from "./task-builder.js";
import { indexRepoForDispatch, injectKnowledgeContext, injectRepoMap } from "./dispatch-context.js";

/**
 * Resolve compute for a stage that specifies a compute_template.
 * Looks up the template from DB, then config. If a matching compute
 * already exists (named "<template>"), reuses it; otherwise provisions one.
 * Returns the compute name to use, or null if no template specified / not found.
 */
export function resolveComputeForStage(
  app: AppContext,
  stageDef: flow.StageDefinition | null,
  sessionId: string,
  log: (msg: string) => void = () => {},
): string | null {
  if (!stageDef?.compute_template) return null;

  const templateName = stageDef.compute_template;

  // Resolve template: DB first, then config
  let tmpl = app.computeTemplates.get(templateName);
  if (!tmpl) {
    const cfgTmpl = (app.config.computeTemplates ?? []).find((t) => t.name === templateName);
    if (cfgTmpl) {
      tmpl = {
        name: cfgTmpl.name,
        description: cfgTmpl.description,
        provider: cfgTmpl.provider as import("../../types/index.js").ComputeProviderName,
        config: cfgTmpl.config,
      };
    }
  }

  if (!tmpl) {
    log(`Compute template '${templateName}' not found, using session default`);
    return null;
  }

  // Check if a compute with the template name already exists
  const existing = app.computes.get(templateName);
  if (existing) {
    log(`Using existing compute '${templateName}' from template`);
    return templateName;
  }

  // Provision a new compute from the template
  log(`Provisioning compute '${templateName}' from template`);
  app.computes.create({
    name: templateName,
    provider: tmpl.provider,
    config: tmpl.config,
  });
  app.events.log(sessionId, "compute_provisioned_from_template", {
    actor: "system",
    data: { template: templateName, provider: tmpl.provider },
  });

  return templateName;
}

/** Hosted-mode dispatch: delegate to the tenant-aware scheduler + remote arkd launch. */
async function dispatchHosted(
  app: AppContext,
  sessionId: string,
  session: ReturnType<AppContext["sessions"]["get"]> & object,
  log: (msg: string) => void,
): Promise<{ ok: boolean; message: string } | null> {
  // Scheduler is only wired in hosted mode; `app.scheduler` throws in local mode.
  let scheduler;
  try {
    scheduler = app.scheduler;
  } catch {
    logDebug("session", "Scheduler not available -- fall through to local dispatch");
    return null;
  }

  const tenantId = session.tenant_id ?? "default";
  log(`Scheduling session for tenant: ${tenantId}`);
  try {
    const worker = await scheduler.schedule(session, tenantId);
    log(`Dispatched to worker ${worker.id} (${worker.url})`);
    const { ArkdClient } = await import("../../arkd/client.js");
    const client = new ArkdClient(worker.url);
    const sessionName = `ark-s-${sessionId}`;
    const script = `#!/bin/bash\necho "Dispatched session ${sessionId}"`;
    await client.launchAgent({
      sessionName,
      script,
      workdir: session.workdir ?? session.repo ?? ".",
    });
    app.sessions.update(sessionId, { status: "running", compute_name: worker.compute_name });
    app.events.log(sessionId, "dispatched_to_worker", {
      actor: "scheduler",
      data: { worker_id: worker.id, worker_url: worker.url, tenant_id: tenantId },
    });
    return { ok: true, message: `Dispatched to worker ${worker.id}` };
  } catch (schedErr: any) {
    return { ok: false, message: schedErr.message ?? "Scheduling failed" };
  }
}

/** Clone a remote repo referenced in session.config.remoteRepo into the worktrees dir. */
async function cloneRemoteRepoIfNeeded(
  app: AppContext,
  sessionId: string,
  session: ReturnType<AppContext["sessions"]["get"]> & object,
  log: (msg: string) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!session.config?.remoteRepo || session.workdir) return { ok: true };
  const remoteUrl = session.config.remoteRepo as string;
  log(`Cloning remote repo: ${remoteUrl}`);
  try {
    const tmpDir = join(app.arkDir, "worktrees", sessionId);
    mkdirSync(tmpDir, { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", remoteUrl, tmpDir], { timeout: 120_000 });
    app.sessions.update(sessionId, { workdir: tmpDir });
    const updated = app.sessions.get(sessionId);
    if (updated) (session as { workdir: string | null }).workdir = updated.workdir;
    log(`Cloned remote repo to ${tmpDir}`);
    app.events.log(sessionId, "remote_repo_cloned", {
      actor: "system",
      data: { url: remoteUrl, dir: tmpDir },
    });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: `Failed to clone remote repo: ${e.message}` };
  }
}

export async function dispatch(
  app: AppContext,
  sessionId: string,
  opts?: { onLog?: (msg: string) => void },
): Promise<{ ok: boolean; message: string }> {
  const log = opts?.onLog ?? (() => {});
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  if (session.status === "running" && session.session_id) {
    return { ok: true, message: `Already running (${session.session_id})` };
  }
  if (session.status !== "ready" && session.status !== "blocked") {
    return { ok: false, message: `Not ready (status: ${session.status}). Stop it first, or wait for it to finish.` };
  }

  const stage = session.stage;
  if (!stage) return { ok: false, message: "No current stage. The session may have completed its flow." };

  // Validate compute exists if specified
  if (session.compute_name && !app.computes.get(session.compute_name)) {
    return { ok: false, message: `Compute '${session.compute_name}' not found. Delete and recreate the session.` };
  }

  // Hosted mode takes precedence; local dispatch runs only if no scheduler is wired.
  const hosted = await dispatchHosted(app, sessionId, session, log);
  if (hosted) return hosted;

  const cloned = await cloneRemoteRepoIfNeeded(app, sessionId, session, log);
  if (!cloned.ok) return cloned;

  // Check task summary for prompt injection
  try {
    const injection = detectInjection(session.summary ?? "");
    if (injection.severity === "high") {
      app.events.log(sessionId, "prompt_injection_blocked", {
        actor: "system",
        data: { patterns: injection.patterns, context: "dispatch" },
      });
      return { ok: false, message: "Dispatch blocked: potential prompt injection in task summary" };
    }
    if (injection.detected) {
      app.events.log(sessionId, "prompt_injection_warning", {
        actor: "system",
        data: { patterns: injection.patterns, severity: injection.severity, context: "dispatch" },
      });
    }
  } catch {
    logDebug("session", "skip guard on error");
  }

  // Check if fork stage
  const stageDef = flow.getStage(app, session.flow, stage);

  // Resolve per-stage compute template override
  const stageCompute = resolveComputeForStage(app, stageDef, sessionId, log);
  if (stageCompute) {
    app.sessions.update(sessionId, { compute_name: stageCompute });
    (session as { compute_name: string | null }).compute_name = stageCompute;
  }

  if (stageDef?.type === "fork") {
    return dispatchFork(app, sessionId, stageDef);
  }

  if (stageDef?.type === "fan_out") {
    return dispatchFanOut(app, sessionId, stageDef);
  }

  const action = flow.getStageAction(app, session.flow, stage);
  if (action.type !== "agent") {
    return { ok: false, message: `Stage '${stage}' is ${action.type}, not agent` };
  }

  const agentName = action.agent!;
  log(`Resolving agent: ${agentName}`);
  const projectRoot = agentRegistry.findProjectRoot(session.workdir || session.repo) ?? undefined;

  // Resolve runtime override from session config (set by --runtime CLI flag)
  const runtimeOverride = session.config?.runtime_override as string | undefined;
  let agent = agentRegistry.resolveAgentWithRuntime(app, agentName, sessionAsVars(session), {
    runtimeOverride,
    projectRoot,
  });
  // Fallback: agents created via the web UI are saved relative to the server's
  // cwd which may differ from the session's workdir/repo (e.g. when the session
  // targets a different repo or a worktree from a prior dispatch).
  if (!agent) {
    const serverRoot = agentRegistry.findProjectRoot(process.cwd()) ?? undefined;
    if (serverRoot && serverRoot !== projectRoot) {
      agent = agentRegistry.resolveAgentWithRuntime(app, agentName, sessionAsVars(session), {
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
  let task = await buildTaskWithHandoff(app, session, stage, agentName);
  // Capture clean user task before context/repo-map injection for event previews
  const taskPreview = (session.summary || task.slice(0, 200)).slice(0, 200);

  // Index codebase into knowledge graph (remote arkd for hosted, local otherwise).
  await indexRepoForDispatch(app, session, log);

  // Inject knowledge-graph context + repo map above/below the task.
  task = await injectKnowledgeContext(app, session, task);
  task = injectRepoMap(session, task);

  // Append rework prompt (set by gate/reject). Single-shot: cleared after a
  // successful launch so subsequent dispatches of the same stage don't replay
  // stale rework instructions.
  const reworkPrompt = session.rework_prompt;
  if (reworkPrompt) {
    task += `\n\n## Rework requested\n\n${reworkPrompt}`;
    log(`Appended rework prompt (rejection #${session.rejection_count ?? 0})`);
  }

  // Log the fully assembled prompt for audit trail
  app.events.log(sessionId, "prompt_sent", {
    stage,
    actor: "orchestrator",
    data: {
      agent: agentName,
      task_preview: task.slice(0, 500),
      task_length: task.length,
      task_full: task,
    },
  });

  // Resolve executor -- use resolved runtime type (from RuntimeStore merge), fall back to agent.runtime, then claude-code.
  // Reads through app.pluginRegistry, the canonical source for extensible collections.
  const runtime = agent._resolved_runtime_type ?? agent.runtime ?? "claude-code";
  const executor = app.pluginRegistry.executor(runtime) ?? getExecutor(runtime);
  if (!executor) return { ok: false, message: `Executor '${runtime}' not registered` };

  // Build claude args (only for claude-code executor)
  const claudeArgs =
    runtime === "claude-code" ? agentRegistry.buildClaudeArgs(agent, { autonomy, projectRoot, app }) : [];

  // Launch via executor
  log(`Launching via ${runtime}...`);
  const launchResult = await executor.launch({
    sessionId,
    workdir: session.workdir ?? session.repo,
    agent,
    task,
    claudeArgs,
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
      ? ((app.computes.get(session.compute_name) as unknown as {
          name: string;
          provider: string;
          [k: string]: unknown;
        } | null) ?? undefined)
      : undefined,
    app,
  });

  if (!launchResult.ok) return { ok: false, message: launchResult.message ?? "Launch failed" };
  const tmuxName = launchResult.handle;

  // Persist launch PID for process-tree tracking
  if (launchResult.pid) {
    app.sessions.mergeConfig(sessionId, {
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
  // belongs to it. Best-effort: tear the just-launched tmux down and log.
  const currentSession = app.sessions.get(sessionId);
  if (!currentSession || currentSession.stage !== stage || currentSession.status === "completed") {
    log(`Session moved past stage '${stage}' during dispatch -- aborting write.`);
    try {
      await app.launcher.kill(tmuxName);
    } catch {
      logDebug("session", "tmux may already be gone");
    }
    return { ok: false, message: `Session moved on during dispatch` };
  }

  app.sessions.update(sessionId, {
    status: "running",
    agent: agentName,
    session_id: tmuxName,
    // Single-shot rework prompt: clear now that it has been delivered. The
    // next dispatch (after approve or another reject) builds a fresh task.
    ...(reworkPrompt ? { rework_prompt: null } : {}),
  });
  if (stageStartSha) {
    app.sessions.mergeConfig(sessionId, { stage_start_sha: stageStartSha });
  }
  app.events.log(sessionId, "stage_started", {
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
    app.flowStates.setCurrentStage(sessionId, session.stage!, session.flow);
  } catch {
    logDebug("session", "skip flow-state on error");
  }

  // Checkpoint after successful dispatch
  saveCheckpoint(app, sessionId);

  // Start status poller for ALL runtimes as a crash detection fallback.
  // Claude uses hook-based status but hooks don't fire when the agent crashes
  // (e.g. MCP config error, OOM, segfault). The poller detects tmux session exit.
  try {
    const { startStatusPoller } = await import("../executors/status-poller.js");
    startStatusPoller(app, sessionId, tmuxName, runtime);
  } catch {
    logDebug("session", "status poller is best-effort -- agent runs fine without it");
  }

  // Observability + telemetry
  recordEvent({ type: "session_start", sessionId, data: { agent: session.agent ?? agentName, flow: session.flow } });
  track("session_dispatched", { agent: agentName });

  return { ok: true, message: tmuxName };
}

export async function resume(
  app: AppContext,
  sessionId: string,
  opts?: { onLog?: (msg: string) => void },
): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status === "running" && session.session_id) return { ok: false, message: "Already running" };

  if (session.session_id) await app.launcher.kill(session.session_id);

  app.sessions.update(sessionId, {
    status: "ready",
    error: null,
    breakpoint_reason: null,
    attached_by: null,
    session_id: null,
  });
  app.events.log(sessionId, "session_resumed", {
    stage: session.stage,
    actor: "user",
    data: { from_status: session.status },
  });

  // Auto re-dispatch
  return await dispatch(app, sessionId, opts);
}

// ── Fork/Fan-out dispatchers ────────────────────────────────────────────────
// These route to fork-join.ts via dynamic import to avoid the cycle where
// fork-join's fork() calls back into dispatch().

async function dispatchFork(
  app: AppContext,
  sessionId: string,
  stageDef: flow.StageDefinition,
): Promise<{ ok: boolean; message: string }> {
  // Read PLAN.md or use default subtasks
  const session = app.sessions.get(sessionId)!;
  const subtasks = await extractSubtasks(app, session);

  const { fork } = await import("./fork-join.js");

  const children: string[] = [];
  for (const sub of subtasks.slice(0, stageDef.max_parallel ?? 4)) {
    const result = await fork(app, sessionId, sub.task, { dispatch: true });
    if (result.ok) children.push(result.sessionId);
  }

  app.sessions.update(sessionId, { status: "running" });
  app.events.log(sessionId, "fork_started", {
    stage: session.stage,
    actor: "system",
    data: { children_count: children.length, children },
  });

  return { ok: true, message: `Forked into ${children.length} sessions` };
}

async function dispatchFanOut(
  app: AppContext,
  sessionId: string,
  stageDef: flow.StageDefinition,
): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId)!;
  const subtasks = await extractSubtasks(app, session);

  const { fanOut } = await import("./fork-join.js");

  const maxParallel = stageDef.max_parallel ?? 8;
  const result = fanOut(app, sessionId, {
    tasks: subtasks.slice(0, maxParallel).map((s) => ({
      summary: s.task,
      agent: stageDef.agent ?? session.agent ?? "implementer",
    })),
  });

  if (!result.ok) return { ok: false, message: result.message ?? "Fan-out failed" };

  // Dispatch all children -- await so their session_ids are registered before returning
  const dispatched = await Promise.allSettled((result.childIds ?? []).map((childId) => dispatch(app, childId)));

  return { ok: true, message: `Fan-out: ${dispatched.length} children dispatched` };
}
