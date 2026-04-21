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
import type { Session } from "../../types/index.js";
import * as flow from "../state/flow.js";
import * as agentRegistry from "../agent/agent.js";
import { saveCheckpoint } from "../session/checkpoint.js";
import { setCurrentStage } from "../state/flow-state.js";
import { logDebug } from "../observability/structured-log.js";
import { recordEvent } from "../observability.js";
import { track } from "../observability/telemetry.js";
import { detectInjection } from "../session/prompt-guard.js";
import { getExecutor } from "../executor.js";

import { sessionAsVars, buildTaskWithHandoff, extractSubtasks } from "./task-builder.js";
import { indexRepoForDispatch, injectKnowledgeContext, injectRepoMap } from "./dispatch-context.js";
import { materializeClaudeAuthForDispatch } from "./dispatch-claude-auth.js";

/**
 * Resolve secret names declared on the stage + runtime into a merged env.
 *
 * Precedence (first wins):
 *   1. Stage `secrets: [NAMES]` -- highest, operator is most specific here.
 *   2. Runtime `secrets: [NAMES]` -- default for every session on that runtime.
 *
 * The resolver calls `app.secrets.resolveMany(tenant, names)` which throws
 * listing every missing name; we surface that as a dispatch failure.
 * Agents with static `env` entries that collide with a secret name are
 * left alone in this pass -- the launch merge handles precedence there
 * (secrets > runtime env > agent env).
 */
async function resolveStageSecrets(
  app: AppContext,
  session: Session,
  stageDef: flow.StageDefinition | null,
  runtimeKind: string,
  log: (msg: string) => void,
): Promise<{ env: Record<string, string>; error?: string }> {
  const names = new Set<string>();
  const stageList = Array.isArray(stageDef?.secrets) ? stageDef.secrets : [];
  for (const n of stageList) names.add(n);
  // Runtime-declared secrets. Pull from the RuntimeStore; avoid
  // hard-failing if the runtime isn't known (legacy executor paths).
  try {
    const rt = app.runtimes?.get?.(runtimeKind) ?? null;
    const rtSecrets = Array.isArray(rt?.secrets) ? (rt as { secrets?: string[] }).secrets! : [];
    for (const n of rtSecrets) names.add(n);
  } catch {
    logDebug("session", "runtime secrets list unavailable -- skipping");
  }
  if (names.size === 0) return { env: {} };
  const tenantId = session.tenant_id ?? app.config.authSection?.defaultTenant ?? "default";
  try {
    const env = await app.secrets.resolveMany(tenantId, Array.from(names));
    log(`Resolved ${Object.keys(env).length} secret env var(s) for tenant ${tenantId}`);
    return { env };
  } catch (err: any) {
    return { env: {}, error: `Secret resolution failed: ${err?.message ?? String(err)}` };
  }
}

/**
 * Resolve compute for a stage that references a named compute target.
 *
 * After the unification of compute targets and templates into a single
 * table, the resolution path is uniform regardless of which axis the
 * stage used:
 *
 *   - `stageDef.compute` -- modern reference.
 *   - `stageDef.compute_template` -- legacy reference, preserved so old
 *     flow YAMLs keep working. Resolved identically to `compute`.
 *
 * Behavior:
 *   - If the named row is not found -> fall through to config-defined
 *     templates (legacy convenience), then return null (session default).
 *   - If the row is a template (`is_template: true`) -> CLONE it into a
 *     fresh per-session concrete row named `<template>-<sessionId8>`,
 *     with `cloned_from = <template>`. GC prunes the clone when the
 *     session reaches a terminal state.
 *   - If the row is concrete -> return its name as-is.
 */
export async function resolveComputeForStage(
  app: AppContext,
  stageDef: flow.StageDefinition | null,
  sessionId: string,
  log: (msg: string) => void = () => {},
): Promise<string | null> {
  const ref = stageDef?.compute ?? stageDef?.compute_template;
  if (!ref) return null;

  const existing = await app.computes.get(ref);

  if (!existing) {
    // Fallback: config-defined template catalog lets users declare
    // templates in ~/.ark/config.yaml without hitting the DB. Seed a
    // fresh template row from config, then clone it below.
    const cfgTmpl = (app.config.computeTemplates ?? []).find((t) => t.name === ref);
    if (cfgTmpl) {
      log(`Seeding template '${ref}' from config`);
      await app.computes.create({
        name: cfgTmpl.name,
        provider: cfgTmpl.provider as import("../../types/index.js").ComputeProviderName,
        config: cfgTmpl.config,
        is_template: true,
      });
      return cloneTemplate(app, cfgTmpl.name, sessionId, log);
    }
    log(`Stage compute '${ref}' not found, falling back to session default`);
    return null;
  }

  if (existing.is_template) {
    return cloneTemplate(app, existing.name, sessionId, log);
  }

  // Concrete target -- use directly, no cloning.
  return existing.name;
}

/**
 * Clone a template row into a per-session concrete row. Inherits provider,
 * compute_kind, runtime_kind and a deep copy of the template's config so
 * per-session mutations (e.g. an assigned pod IP) don't leak back.
 */
async function cloneTemplate(
  app: AppContext,
  templateName: string,
  sessionId: string,
  log: (msg: string) => void,
): Promise<string> {
  const tmpl = await app.computes.get(templateName);
  if (!tmpl) {
    // Shouldn't happen -- caller already checked -- but be defensive.
    log(`Template '${templateName}' disappeared before clone`);
    return templateName;
  }

  const cloneName = `${templateName}-${sessionId.slice(0, 8)}`;

  // Idempotent: if a prior dispatch for this session already cloned the
  // template (e.g. on resume), reuse the existing clone.
  const existingClone = await app.computes.get(cloneName);
  if (existingClone) {
    log(`Reusing existing clone '${cloneName}' of template '${templateName}'`);
    return cloneName;
  }

  log(`Cloning template '${templateName}' into '${cloneName}' for session ${sessionId}`);
  await app.computes.create({
    name: cloneName,
    provider: tmpl.provider,
    compute: tmpl.compute_kind,
    runtime: tmpl.runtime_kind,
    // Deep-copy via JSON round-trip so later per-session mutations don't
    // leak back into the template row.
    config: JSON.parse(JSON.stringify(tmpl.config ?? {})),
    is_template: false,
    cloned_from: templateName,
  });
  await app.events.log(sessionId, "compute_cloned_from_template", {
    actor: "system",
    data: { template: templateName, clone: cloneName, provider: tmpl.provider },
  });
  return cloneName;
}

/** Hosted-mode dispatch: delegate to the tenant-aware scheduler + remote arkd launch. */
async function dispatchHosted(
  app: AppContext,
  sessionId: string,
  session: Session,
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
    await app.sessions.update(sessionId, { status: "running", compute_name: worker.compute_name });
    await app.events.log(sessionId, "dispatched_to_worker", {
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
  session: Session,
  log: (msg: string) => void,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!session.config?.remoteRepo || session.workdir) return { ok: true };
  const remoteUrl = session.config.remoteRepo as string;
  log(`Cloning remote repo: ${remoteUrl}`);
  try {
    const tmpDir = join(app.arkDir, "worktrees", sessionId);
    mkdirSync(tmpDir, { recursive: true });
    await execFileAsync("git", ["clone", "--depth", "1", remoteUrl, tmpDir], { timeout: 120_000 });
    await app.sessions.update(sessionId, { workdir: tmpDir });
    const updated = await app.sessions.get(sessionId);
    if (updated) (session as { workdir: string | null }).workdir = updated.workdir;
    log(`Cloned remote repo to ${tmpDir}`);
    await app.events.log(sessionId, "remote_repo_cloned", {
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
  const session = await app.sessions.get(sessionId);
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
  if (session.compute_name && !(await app.computes.get(session.compute_name))) {
    return { ok: false, message: `Compute '${session.compute_name}' not found. Delete and recreate the session.` };
  }

  // Action stages execute in-process regardless of hosted/local mode -- they
  // don't launch an agent, don't need an arkd worker, and must not be
  // scheduled like one. Handle them here before the hosted scheduler path
  // so single-action flows can auto-complete on the control plane without
  // waiting on a worker that will never have anything to do.
  const earlyAction = flow.getStageAction(app, session.flow, stage);
  if (earlyAction.type === "action") {
    const { executeAction } = await import("./actions/index.js");
    const { mediateStageHandoff } = await import("./session-hooks.js");
    const result = await executeAction(app, sessionId, earlyAction.action ?? "");
    if (!result.ok) {
      await app.sessions.update(sessionId, {
        status: "failed",
        error: `Action '${earlyAction.action}' failed: ${result.message.slice(0, 200)}`,
      });
      return { ok: false, message: result.message };
    }
    const postAction = await app.sessions.get(sessionId);
    if (postAction?.status === "ready") {
      await mediateStageHandoff(app, sessionId, { autoDispatch: true, source: "dispatch_action" });
    }
    return { ok: true, message: `Executed action '${earlyAction.action}'` };
  }

  // Hosted mode takes precedence; local dispatch runs only if no scheduler is wired.
  const hosted = await dispatchHosted(app, sessionId, session, log);
  if (hosted) return hosted;

  const cloned = await cloneRemoteRepoIfNeeded(app, sessionId, session, log);
  if (cloned.ok === false) return { ok: false, message: cloned.message };

  // Check task summary for prompt injection
  try {
    const injection = detectInjection(session.summary ?? "");
    if (injection.severity === "high") {
      await app.events.log(sessionId, "prompt_injection_blocked", {
        actor: "system",
        data: { patterns: injection.patterns, context: "dispatch" },
      });
      return { ok: false, message: "Dispatch blocked: potential prompt injection in task summary" };
    }
    if (injection.detected) {
      await app.events.log(sessionId, "prompt_injection_warning", {
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
  const stageCompute = await resolveComputeForStage(app, stageDef, sessionId, log);
  if (stageCompute) {
    await app.sessions.update(sessionId, { compute_name: stageCompute });
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
  await app.events.log(sessionId, "prompt_sent", {
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

  // Resolve secrets declared on the stage + the runtime and merge them
  // into the launch env. Stage secrets win over runtime secrets on name
  // conflict. A missing secret fails dispatch with a clear message --
  // we never silently drop an env var the agent depends on.
  const secretEnv = await resolveStageSecrets(app, session, stageDef, runtime, log);
  if (secretEnv.error) return { ok: false, message: secretEnv.error };

  // Tenant-level claude auth materialization. Runs BEFORE we read the
  // compute row for launch so any `credsSecretName` mutation lands before
  // the provider sees it. A tenant bound to `api_key` contributes
  // ANTHROPIC_API_KEY to the launch env; a tenant bound to
  // `subscription_blob` on k8s-family compute triggers per-session k8s
  // Secret creation + `credsSecretName` mergeConfig.
  const computeForAuth = session.compute_name ? await app.computes.get(session.compute_name) : null;
  const claudeAuth = await materializeClaudeAuthForDispatch(app, session, computeForAuth);
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
    agent,
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
      ? (((await app.computes.get(session.compute_name)) as unknown as {
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
    await app.sessions.mergeConfig(sessionId, {
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
  const currentSession = await app.sessions.get(sessionId);
  if (!currentSession || currentSession.stage !== stage || currentSession.status === "completed") {
    log(`Session moved past stage '${stage}' during dispatch -- aborting write.`);
    try {
      await app.launcher.kill(tmuxName);
    } catch {
      logDebug("session", "tmux may already be gone");
    }
    return { ok: false, message: `Session moved on during dispatch` };
  }

  await app.sessions.update(sessionId, {
    status: "running",
    agent: agentName,
    session_id: tmuxName,
    // Single-shot rework prompt: clear now that it has been delivered. The
    // next dispatch (after approve or another reject) builds a fresh task.
    ...(reworkPrompt ? { rework_prompt: null } : {}),
  });
  if (stageStartSha) {
    await app.sessions.mergeConfig(sessionId, { stage_start_sha: stageStartSha });
  }
  await app.events.log(sessionId, "stage_started", {
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
    setCurrentStage(app, sessionId, session.stage!, session.flow);
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
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status === "running" && session.session_id) return { ok: false, message: "Already running" };

  if (session.session_id) await app.launcher.kill(session.session_id);

  await app.sessions.update(sessionId, {
    status: "ready",
    error: null,
    breakpoint_reason: null,
    attached_by: null,
    session_id: null,
  });
  await app.events.log(sessionId, "session_resumed", {
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
  const session = (await app.sessions.get(sessionId))!;
  const subtasks = extractSubtasks(app, session);

  const { fork } = await import("./fork-join.js");

  const children: string[] = [];
  for (const sub of subtasks.slice(0, stageDef.max_parallel ?? 4)) {
    const result = await fork(app, sessionId, sub.task, { dispatch: true });
    if (result.ok) children.push(result.sessionId);
  }

  await app.sessions.update(sessionId, { status: "running" });
  await app.events.log(sessionId, "fork_started", {
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
  const session = (await app.sessions.get(sessionId))!;
  const subtasks = extractSubtasks(app, session);

  const { fanOut } = await import("./fork-join.js");

  const maxParallel = stageDef.max_parallel ?? 8;
  const result = await fanOut(app, sessionId, {
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
