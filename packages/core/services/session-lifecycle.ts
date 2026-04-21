/**
 * Session lifecycle -- start, stop, resume, pause, archive, restore, interrupt,
 * fork, clone, handoff, delete, wait, verification, review gates.
 *
 * Extracted from session-orchestration.ts. All functions take app: AppContext as first arg.
 */

import { execFileSync } from "child_process";
import { promisify } from "util";
import { execFile } from "child_process";

const execFileAsync = promisify(execFile);

import type { AppContext } from "../app.js";
import type { Session, Compute } from "../../types/index.js";
import type { ComputeProvider } from "../../compute/types.js";
import type { ComputeTarget } from "../../compute/core/compute-target.js";
import * as flow from "../state/flow.js";
import * as claude from "../claude/claude.js";
import { loadRepoConfig } from "../repo-config.js";
import { safeAsync } from "../safe.js";
import { saveCheckpoint } from "../session/checkpoint.js";
import { profileGroupPrefix } from "../state/profiles.js";
import { logDebug, logError, logInfo, logWarn } from "../observability/structured-log.js";
import { recordEvent } from "../observability.js";
import { track } from "../observability/telemetry.js";
import { resolveProvider } from "../provider-registry.js";
import {
  emitSessionSpanStart,
  emitSessionSpanEnd,
  emitStageSpanStart,
  emitStageSpanEnd,
  flushSpans,
} from "../observability/otlp.js";
import { removeSessionWorktree } from "./workspace-service.js";
import { substituteVars, buildSessionVars } from "../template.js";
import { provisionWorkspaceWorkdir } from "../workspace/provisioner.js";
import { deletePerSessionCredsSecret } from "./dispatch-claude-auth.js";

export type SessionOpResult = { ok: true; sessionId: string } | { ok: false; message: string };

/** Resolve GitHub repo URL from a local git directory. Returns null if not a GitHub repo. */
function resolveGitHubUrl(dir?: string | null): string | null {
  if (!dir) return null;
  try {
    const remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
    // git@github.com:owner/repo.git -> https://github.com/owner/repo
    const sshMatch = remote.match(/git@github\.com:([^/]+\/[^.]+)/);
    if (sshMatch) return `https://github.com/${sshMatch[1]}`;
    // https://github.com/owner/repo.git -> https://github.com/owner/repo
    const httpsMatch = remote.match(/(https:\/\/github\.com\/[^/]+\/[^/.]+)/);
    if (httpsMatch) return httpsMatch[1];
    return null;
  } catch (e: any) {
    // Expected: "not a git repo" or no remote configured. Unexpected errors should be visible.
    const msg = String(e?.message ?? e);
    if (!msg.includes("not a git repository") && !msg.includes("No such remote")) {
      logWarn("session", `resolveGitHubUrl: ${msg}`);
    }
    return null;
  }
}

export async function startSession(
  app: AppContext,
  opts: {
    ticket?: string;
    summary?: string;
    repo?: string;
    flow?: string;
    agent?: string | null;
    compute_name?: string;
    workdir?: string;
    group_name?: string;
    config?: Record<string, unknown>;
    /**
     * Workspace id for workspace-scoped dispatch (Wave 2b). When set, the
     * session workdir becomes a parallel multi-repo tree under
     * `~/.ark/workspaces/<session_id>/` with an `.ark-workspace.yaml`
     * manifest. LOCAL compute only -- remote compute targets are Wave 2b-2.
     * When only `repo` is set, legacy single-worktree behaviour is preserved.
     */
    workspace_id?: string | null;
    inputs?: { files?: Record<string, string>; params?: Record<string, string> };
    attachments?: Array<{ name: string; content: string; type: string }>;
  },
): Promise<Session> {
  const repoDir = opts.workdir ?? opts.repo;
  const repoConfig = repoDir ? loadRepoConfig(repoDir) : {};

  // Prepend active profile prefix to group name for session scoping
  const prefix = profileGroupPrefix();
  const rawGroup = opts.group_name ?? repoConfig.group;
  const groupName = prefix ? `${prefix}${rawGroup ?? ""}` : (rawGroup ?? undefined);

  const mergedOpts = {
    ...opts,
    flow: opts.flow ?? repoConfig.flow,
    compute_name: opts.compute_name ?? repoConfig.compute,
    group_name: groupName,
    workspace_id: opts.workspace_id ?? null,
  };

  // Resolve GitHub repo URL from git remote
  const repoUrl = resolveGitHubUrl(opts.workdir ?? opts.repo);
  if (repoUrl) {
    mergedOpts.config = { ...(mergedOpts.config ?? {}), github_url: repoUrl };
  }

  // Store file attachments in config so they are available for agent prompts
  if (opts.attachments?.length) {
    mergedOpts.config = {
      ...(mergedOpts.config ?? {}),
      attachments: opts.attachments.map((a) => ({
        name: a.name,
        content: a.content,
        type: a.type,
      })),
    };
  }

  // Persist generic inputs bag (files=role->path, params=k->v). Template
  // substitution flattens these to `{{inputs.files.<role>}}` /
  // `{{inputs.params.<key>}}` via `buildSessionVars`.
  if (opts.inputs && (opts.inputs.files || opts.inputs.params)) {
    mergedOpts.config = {
      ...(mergedOpts.config ?? {}),
      inputs: {
        ...(opts.inputs.files ? { files: { ...opts.inputs.files } } : {}),
        ...(opts.inputs.params ? { params: { ...opts.inputs.params } } : {}),
      },
    };
  }

  const session = await app.sessions.create(mergedOpts);

  // Workspace-scoped dispatch (Wave 2b-1 -- LOCAL compute only). When a
  // workspace_id is set, lay out `~/.ark/workspaces/<session_id>/` with a
  // YAML manifest listing every repo in the workspace (`cloned: false`).
  // First-touch `ensureRepoCloned` materialises a repo later. Legacy
  // single-repo sessions are untouched. Errors here fail session startup
  // loudly rather than silently falling back to a repo-only workdir.
  if (mergedOpts.workspace_id) {
    const ws = await app.codeIntel.getWorkspace(mergedOpts.workspace_id);
    if (!ws) {
      throw new Error(`workspace ${mergedOpts.workspace_id} not found; cannot dispatch session ${session.id}`);
    }
    const reposInWs = opts.repo ? await app.codeIntel.listReposInWorkspace(ws.tenant_id, ws.id) : [];
    const primaryRepoId =
      opts.repo && ws
        ? (reposInWs.find((r) => r.name === opts.repo || r.local_path === opts.repo || r.repo_url === opts.repo)?.id ??
          null)
        : null;
    const wsWorkdir = await provisionWorkspaceWorkdir(app, session, ws, { primaryRepoId });
    await app.sessions.update(session.id, { workdir: wsWorkdir });
    (session as { workdir: string | null }).workdir = wsWorkdir;
  }

  // Audit: log session creation with full context
  await app.events.log(session.id, "session_created", {
    actor: "user",
    data: {
      summary: opts.summary,
      flow: mergedOpts.flow ?? "default",
      agent: opts.agent ?? null,
      compute: mergedOpts.compute_name ?? "local",
      repo: opts.repo ?? opts.workdir ?? null,
      group: mergedOpts.group_name ?? null,
    },
  });

  // Telemetry: track session creation
  track("session_created", { flow: mergedOpts.flow ?? "default" });

  // Apply agent override if specified
  if (opts.agent) {
    await app.sessions.update(session.id, { agent: opts.agent });
  }

  // Prefetch flow via the async path so the hosted DB-backed store warms
  // its sync cache. Without this, the hosted `DbResourceStore.get` returns
  // a Promise on first hit, `loadFlow` treats it as unresolved, and
  // `getFirstStage` returns null -- which leaves the session wedged at
  // `status: pending` forever because no first stage is ever set.
  try {
    await app.flows.get(mergedOpts.flow ?? "default");
  } catch {
    logDebug("session", "flow prefetch failed -- continue and rely on legacy sync path");
  }

  // Set first stage
  const firstStage = flow.getFirstStage(app, mergedOpts.flow ?? "default");
  if (firstStage) {
    const action = flow.getStageAction(app, mergedOpts.flow ?? "default", firstStage);
    await app.sessions.update(session.id, { stage: firstStage, status: "ready" });
    await app.events.log(session.id, "stage_ready", {
      stage: firstStage,
      actor: "system",
      data: { stage: firstStage, gate: "auto", stage_type: action.type, stage_agent: action.agent },
    });

    emitSessionSpanStart(session.id, {
      flow: mergedOpts.flow ?? "default",
      repo: opts.repo,
      agent: opts.agent ?? undefined,
    });
    if (firstStage) {
      const stageAction = flow.getStageAction(app, mergedOpts.flow ?? "default", firstStage);
      emitStageSpanStart(session.id, { stage: firstStage, agent: stageAction.agent, gate: "auto" });
    }
  }

  // Broadcast lifecycle hook so the service layer can react (the default
  // listener kicks a background dispatch). Emitted AFTER the first stage is
  // persisted -- if we emit earlier (as we used to) the listener's dispatch
  // call sees `stage: null` and bails with "No current stage", which left
  // action-only flows wedged at `status: ready` until an RPC
  // `session/advance` came in manually.
  app.sessionService.emitSessionCreated(session.id);

  return (await app.sessions.get(session.id))!;
}

/**
 * Record token usage from a session transcript into UsageRecorder.
 * Resolves the runtime's billing mode (api/subscription/free) so that
 * subscription-based runtimes get cost_usd=0 while still tracking tokens.
 */
export function recordSessionUsage(
  app: AppContext,
  session: Session,
  usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number; cache_write_tokens?: number },
  provider: string,
  source: string,
): void {
  if (!usage.input_tokens && !usage.output_tokens) return;
  try {
    const runtimeName = (session.config?.runtime as string | undefined) ?? session.agent ?? "claude";
    const runtime = app.runtimes.get(runtimeName);
    const billingMode = runtime?.billing?.mode ?? "api";
    const model = (session.config?.model as string | undefined) ?? runtime?.default_model ?? "sonnet";

    app.usageRecorder.record({
      sessionId: session.id,
      tenantId: session.tenant_id ?? "default",
      userId: session.user_id ?? "system",
      model,
      provider,
      runtime: runtimeName,
      agentRole: session.agent ?? undefined,
      usage,
      source,
      costMode: billingMode,
    });
  } catch (e: any) {
    logError("session", "usage record failed", { sessionId: session.id, error: String(e?.message ?? e) });
  }
}

/** Safely run a provider method for a session. Resolves provider, handles null, logs errors. */
async function withProvider(
  session: Session,
  label: string,
  fn: (provider: ComputeProvider, compute: Compute) => Promise<void>,
): Promise<boolean> {
  const { provider, compute } = await resolveProvider(session);
  if (!provider || !compute) return false;
  return safeAsync(label, () => fn(provider, compute));
}

/**
 * Invoke a ComputeTarget method for a session when the compute row maps to a
 * registered (compute, runtime) pair. Returns true on success, false when no
 * target is available (caller should fall back to the legacy provider path
 * in that case). Errors during dispatch are logged and swallowed -- the
 * session lifecycle always prefers proceeding with cleanup over blocking on
 * a runtime that refuses to shut down.
 */
async function withComputeTarget(
  app: AppContext,
  session: Session,
  label: string,
  fn: (target: ComputeTarget, compute: Compute) => Promise<void>,
): Promise<boolean> {
  try {
    const { target, compute } = await app.resolveComputeTarget(session);
    if (!target || !compute) return false;
    return safeAsync(label, () => fn(target, compute));
  } catch (e: any) {
    logError("session", `${label}: resolveComputeTarget failed: ${e?.message ?? e}`);
    return false;
  }
}

export async function stop(
  app: AppContext,
  sessionId: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // Skip if already stopped (unless force -- used by stopAll for cleanup)
  if (!opts?.force && ["stopped", "completed", "failed"].includes(session.status) && !session.session_id) {
    return { ok: true, message: "Already stopped" };
  }

  // Kill tracked process trees before blunt tmux/provider kill
  try {
    const { killProcessTree } = await import("../executors/process-tree.js");
    const launchPid = session.config?.launch_pid as number | undefined;
    if (launchPid) await killProcessTree(launchPid);
    // Also kill PIDs from the process_tree snapshot (recorded by status poller)
    const tree = (session.config?.process_tree ?? []) as Array<{ pid: number }>;
    for (const entry of tree) {
      if (entry.pid) await killProcessTree(entry.pid);
    }
  } catch {
    logDebug("session", "fall through to tmux kill");
  }

  // Kill agent + clean up provider resources FIRST (before any DB writes).
  // This ensures processes are stopped even if subsequent DB ops fail.
  //
  // Legacy ComputeProvider still owns killAgent/cleanupSession (the new
  // Compute/Runtime interfaces do not cover them yet). After the provider
  // path runs we give the Runtime a chance to shut down per-session state via
  // ComputeTarget.shutdown -- DirectRuntime / LocalCompute is a no-op;
  // DockerRuntime tears down its sidecar container.
  const stopped = await withProvider(session, `stop ${sessionId}`, async (p, c) => {
    await p.killAgent(c, session);
    await p.cleanupSession(c, session);
  });
  if (!stopped && session.session_id) {
    // Fallback: kill via launcher (no compute assigned)
    await app.launcher.kill(session.session_id);
  }

  // Runtime-level teardown via ComputeTarget.shutdown. Builds a stub handle
  // from the compute name; runtimes that stashed per-session meta on the
  // handle (e.g. DockerRuntime.DockerHandleMeta) will detect the missing
  // meta and no-op safely, matching today's cleanupSession semantics.
  await withComputeTarget(app, session, `stop ${sessionId}: shutdown runtime`, async (target, c) => {
    await target.shutdown({ kind: target.compute.kind, name: c.name, meta: {} });
  });

  // Stop status poller if active (non-Claude executors)
  try {
    const { stopStatusPoller } = await import("../executors/status-poller.js");
    stopStatusPoller(sessionId);
  } catch {
    logDebug("session", "poller may not be running -- safe to ignore");
  }

  // Checkpoint before state transition
  saveCheckpoint(app, sessionId);

  // Tenant-level claude auth teardown: if dispatch materialized a
  // per-session k8s Secret (subscription-blob mode), delete it now.
  // Idempotent -- a missing Secret (crashed daemon, double-stop,
  // concurrent GC) never fails teardown.
  try {
    const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
    await deletePerSessionCredsSecret(app, session, compute);
  } catch (e: any) {
    logError("session", `stop ${sessionId}: creds secret cleanup: ${e?.message ?? e}`);
  }

  // Clean up hook config and channel MCP config from working directory
  if (session.workdir) {
    try {
      claude.removeSettings(session.workdir);
    } catch (e: any) {
      logError("session", `stop ${sessionId}: removeSettings: ${e?.message ?? e}`);
    }
    try {
      claude.removeChannelConfig(session.workdir);
    } catch (e: any) {
      logError("session", `stop ${sessionId}: removeChannelConfig: ${e?.message ?? e}`);
    }
  }

  // Clean up worktree directory (provider-independent -- ensures cleanup even
  // when no compute is assigned or provider doesn't handle local worktrees)
  await removeSessionWorktree(app, session);

  // Preserve claude_session_id so restart can --resume the conversation
  await app.sessions.update(sessionId, { status: "stopped", error: null, session_id: null });
  await app.events.log(sessionId, "session_stopped", {
    stage: session.stage,
    actor: "user",
    data: { session_id: session.session_id, agent: session.agent },
  });

  // Observability: track session stop
  recordEvent({ type: "session_end", sessionId, data: { status: "stopped" } });

  // GC any template-lifecycle compute the session was using (k8s, docker,
  // firecracker, ...). Persistent computes (local, ec2) are kept around.
  try {
    const { garbageCollectComputeIfTemplate } = await import("./compute-lifecycle.js");
    await garbageCollectComputeIfTemplate(app, session.compute_name);
  } catch (e: any) {
    logDebug("session", `compute gc on stop ${sessionId}: ${e?.message ?? e}`);
  }

  emitStageSpanEnd(sessionId, { status: "stopped" });
  emitSessionSpanEnd(sessionId, { status: "stopped" });
  flushSpans();

  return { ok: true, message: "Session stopped" };
}

export interface VerificationResult {
  ok: boolean;
  todosResolved: boolean;
  pendingTodos: string[];
  scriptResults: Array<{ script: string; passed: boolean; output: string }>;
  message: string;
}

/**
 * Function signature for running a single verify script. Abstracted so tests
 * can stub out the bash shell-out. Resolves on success, rejects on non-zero
 * exit -- the rejection shape mirrors the underlying promisified execFile
 * (`e.stdout`, `e.stderr`, `e.message`).
 */
export type VerifyScriptRunner = (
  script: string,
  opts: { cwd?: string; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultVerifyScriptRunner: VerifyScriptRunner = async (script, opts) => {
  const { stdout, stderr } = await execFileAsync("bash", ["-c", script], {
    cwd: opts.cwd,
    encoding: "utf-8",
    timeout: opts.timeoutMs,
  });
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
};

/**
 * Run verification for a session: check todos are resolved and verify scripts
 * pass. Returns structured results for display and enforcement.
 *
 * The `runScript` seam lets tests replace the default shell-out with a stub;
 * production callers should omit it.
 */
export async function runVerification(
  app: AppContext,
  sessionId: string,
  opts?: { runScript?: VerifyScriptRunner; timeoutMs?: number },
): Promise<VerificationResult> {
  const session = await app.sessions.get(sessionId);
  if (!session)
    return { ok: false, todosResolved: true, pendingTodos: [], scriptResults: [], message: "Session not found" };

  // Check todos
  const todos = await app.todos.list(sessionId);
  const pending = todos.filter((t) => !t.done);
  const todosResolved = pending.length === 0;

  // Determine verify scripts from flow stage + repo config
  const stageVerify =
    session.stage && session.flow ? flow.getStage(app, session.flow, session.stage)?.verify : undefined;
  const repoConfig = session.workdir ? loadRepoConfig(session.workdir) : {};
  const scripts: string[] = stageVerify ?? repoConfig.verify ?? [];

  // Run each script in the session workdir
  const workdir = session.workdir ?? session.repo;
  const scriptResults: Array<{ script: string; passed: boolean; output: string }> = [];
  const runScript = opts?.runScript ?? defaultVerifyScriptRunner;
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  for (const script of scripts) {
    try {
      const { stdout, stderr } = await runScript(script, { cwd: workdir ?? undefined, timeoutMs });
      scriptResults.push({ script, passed: true, output: (stdout + stderr).slice(0, 5000) });
    } catch (e: any) {
      const output = ((e?.stderr ?? "") + (e?.stdout ?? "") + (e?.message ?? "")).slice(0, 5000);
      scriptResults.push({ script, passed: false, output });
    }
  }

  const allScriptsPassed = scriptResults.every((r) => r.passed);
  const ok = todosResolved && allScriptsPassed;

  // Build human-readable message
  const parts: string[] = [];
  if (!todosResolved) parts.push(`${pending.length} unresolved todo(s): ${pending.map((t) => t.content).join(", ")}`);
  for (const r of scriptResults) {
    if (!r.passed) parts.push(`verify failed: ${r.script}\n${r.output}`);
  }

  return {
    ok,
    todosResolved,
    pendingTodos: pending.map((t) => t.content),
    scriptResults,
    message: ok ? "Verification passed" : parts.join("\n"),
  };
}

export async function pause(
  app: AppContext,
  sessionId: string,
  reason?: string,
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  await app.sessions.update(sessionId, { status: "blocked", breakpoint_reason: reason ?? "User paused" });
  await app.events.log(sessionId, "session_paused", {
    stage: session.stage,
    actor: "user",
    data: { reason, was_status: session.status },
  });
  return { ok: true, message: "Paused" };
}

export async function archive(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // Stop if running
  if (session.session_id) {
    await app.launcher.kill(session.session_id);
  }

  await app.sessions.update(sessionId, { status: "archived", session_id: null });
  await app.events.log(sessionId, "session_archived", {
    stage: session.stage,
    actor: "user",
    data: { from_status: session.status },
  });
  return { ok: true, message: "Session archived" };
}

export async function restore(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status !== "archived") return { ok: false, message: `Session is ${session.status}, not archived` };

  await app.sessions.update(sessionId, { status: "stopped" });
  await app.events.log(sessionId, "session_restored", {
    stage: session.stage,
    actor: "user",
    data: {},
  });
  return { ok: true, message: "Session restored" };
}

export async function interrupt(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status !== "running" && session.status !== "waiting") {
    return { ok: false, message: `Session is ${session.status}, not running` };
  }
  if (!session.session_id) return { ok: false, message: "No tmux session" };

  // Send Ctrl+C to interrupt the agent without killing the session
  await app.launcher.sendKeys(session.session_id, "C-c");

  await app.sessions.update(sessionId, { status: "waiting" });
  await app.events.log(sessionId, "session_interrupted", {
    stage: session.stage,
    actor: "user",
    data: { session_id: session.session_id },
  });

  return { ok: true, message: "Agent interrupted" };
}

/** Open a review gate -- called when PR is approved via webhook. */
export async function approveReviewGate(
  app: AppContext,
  sessionId: string,
  advanceFn: (app: AppContext, sessionId: string, force?: boolean) => Promise<{ ok: boolean; message: string }>,
): Promise<{ ok: boolean; message: string }> {
  const s = await app.sessions.get(sessionId);
  if (!s) return { ok: false, message: "Session not found" };

  await app.events.log(sessionId, "review_approved", {
    stage: s.stage ?? undefined,
    actor: "github",
  });

  // Force-advance past the review gate
  return await advanceFn(app, sessionId, true);
}

/**
 * Render the rework prompt template. Uses the standard Nunjucks template
 * engine; `{{rejection_reason}}` is injected alongside the session vars.
 */
export function renderReworkPrompt(template: string, reason: string, sessionVars: Record<string, string>): string {
  const merged: Record<string, string> = { ...sessionVars, rejection_reason: reason };
  return substituteVars(template, merged);
}

/** Default rework prompt when the flow stage doesn't declare one. */
const DEFAULT_REWORK_PROMPT = "Rework required. Reviewer said: {{rejection_reason}}";

/**
 * Reject a review gate: render the rework prompt, persist it, bump the rework
 * counter, clear the runtime session id so the next dispatch starts fresh, log
 * a `review_rejected` event, and re-dispatch the same stage. When
 * `on_reject.max_rejections` is exceeded, the session is marked `failed`
 * instead of re-dispatched.
 */
export async function rejectReviewGate(
  app: AppContext,
  sessionId: string,
  reason: string,
  dispatchFn: (app: AppContext, sessionId: string) => Promise<{ ok: boolean; message: string }>,
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: "Session not found" };

  const stageName = session.stage;
  if (!stageName) return { ok: false, message: "Session has no current stage" };

  const stageDef = flow.getStage(app, session.flow, stageName);
  if (!stageDef) return { ok: false, message: `Stage '${stageName}' not found in flow '${session.flow}'` };

  if (stageDef.gate !== "review" && stageDef.gate !== "manual") {
    return {
      ok: false,
      message: `Stage '${stageName}' gate is '${stageDef.gate}', expected 'review' or 'manual'`,
    };
  }

  const onReject = stageDef.on_reject;
  const max = onReject?.max_rejections;
  const currentCount = session.rejection_count ?? 0;

  // Enforce the cap BEFORE mutating session state so a hit doesn't bump the counter.
  if (typeof max === "number" && max >= 0 && currentCount >= max) {
    await app.sessions.update(sessionId, { status: "failed", error: "max_rejections exceeded" });
    await app.events.log(sessionId, "review_rejected", {
      stage: stageName,
      actor: "user",
      data: { reason, rejection_count: currentCount, max_rejections: max, capped: true },
    });
    await app.events.log(sessionId, "session_failed", {
      stage: stageName,
      actor: "system",
      data: { reason: "max_rejections exceeded", rejection_count: currentCount, max_rejections: max },
    });
    return { ok: false, message: "max_rejections exceeded" };
  }

  // Render the rework prompt (declared or default).
  const vars = buildSessionVars(session as unknown as Record<string, unknown>);
  const template = onReject?.prompt && onReject.prompt.trim() ? onReject.prompt : DEFAULT_REWORK_PROMPT;
  const rendered = renderReworkPrompt(template, reason, vars);

  const nextCount = currentCount + 1;
  await app.sessions.update(sessionId, {
    rework_prompt: rendered,
    rejection_count: nextCount,
    rejected_at: new Date().toISOString(),
    rejected_reason: reason,
    // Clear claude_session_id so the re-dispatch starts a fresh runtime --
    // matches Archon's `fresh_context` intuition. Also clear the tmux/session
    // handle so dispatch() will launch again instead of short-circuiting.
    claude_session_id: null,
    session_id: null,
    // Re-open the gate: set status back to 'ready' so dispatch() accepts it.
    status: "ready",
    error: null,
  });

  await app.events.log(sessionId, "review_rejected", {
    stage: stageName,
    actor: "user",
    data: { reason, rejection_count: nextCount, max_rejections: max ?? null },
  });

  return await dispatchFn(app, sessionId);
}

/**
 * Fork: shallow copy - same compute, repo, flow, group. Fresh session, no resume.
 */
export async function forkSession(app: AppContext, sessionId: string, newName?: string): Promise<SessionOpResult> {
  const original = await app.sessions.get(sessionId);
  if (!original) return { ok: false, message: `Session ${sessionId} not found` };

  const baseName = original.summary || sessionId;
  const fork = await app.sessions.create({
    ticket: original.ticket || undefined,
    summary: newName ?? `${baseName} (fork)`,
    repo: original.repo || undefined,
    flow: original.flow,
    compute_name: original.compute_name || undefined,
    workdir: original.workdir || undefined,
  });

  await app.sessions.update(fork.id, {
    stage: original.stage,
    status: "ready",
    group_name: original.group_name,
  });

  await app.events.log(fork.id, "session_forked", {
    stage: original.stage,
    actor: "user",
    data: { forked_from: sessionId },
  });

  app.sessionService.emitSessionCreated(fork.id);
  return { ok: true, sessionId: fork.id };
}

/**
 * Clone: deep copy - same as fork PLUS claude_session_id for --resume.
 * The new session will resume the same Claude conversation.
 */
export async function cloneSession(app: AppContext, sessionId: string, newName?: string): Promise<SessionOpResult> {
  const original = await app.sessions.get(sessionId);
  if (!original) return { ok: false, message: `Session ${sessionId} not found` };

  const baseName = original.summary || sessionId;
  const clone = await app.sessions.create({
    ticket: original.ticket || undefined,
    summary: newName ?? `${baseName} (clone)`,
    repo: original.repo || undefined,
    flow: original.flow,
    compute_name: original.compute_name || undefined,
    workdir: original.workdir || undefined,
  });

  await app.sessions.update(clone.id, {
    stage: original.stage,
    status: "ready",
    group_name: original.group_name,
    claude_session_id: original.claude_session_id, // --resume handoff
  });

  await app.events.log(clone.id, "session_cloned", {
    stage: original.stage,
    actor: "user",
    data: { cloned_from: sessionId, claude_session_id: original.claude_session_id },
  });

  app.sessionService.emitSessionCreated(clone.id);
  return { ok: true, sessionId: clone.id };
}

/**
 * Fully delete a session: kill agent, clean up provider resources, clean
 * hooks, delete DB rows. All provider-specific logic delegated to the provider.
 */
export async function deleteSessionAsync(
  app: AppContext,
  sessionId: string,
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // 1. Kill agent + clean up provider resources
  const handled = await withProvider(session, `delete ${sessionId}`, async (p, c) => {
    await p.killAgent(c, session);
    await p.cleanupSession(c, session);
  });
  if (!handled && session.session_id) {
    await app.launcher.kill(session.session_id);
  }

  // 2. Clean up hook config and channel MCP config (not provider-dependent)
  if (session.workdir) {
    try {
      claude.removeSettings(session.workdir);
    } catch (e: any) {
      logError("session", `delete ${sessionId}: removeSettings: ${e?.message ?? e}`);
    }
    try {
      claude.removeChannelConfig(session.workdir);
    } catch (e: any) {
      logError("session", `delete ${sessionId}: removeChannelConfig: ${e?.message ?? e}`);
    }
  }

  // 2b. Tenant-level claude auth teardown -- idempotent, mirrors stop().
  try {
    const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
    await deletePerSessionCredsSecret(app, session, compute);
  } catch (e: any) {
    logError("session", `delete ${sessionId}: creds secret cleanup: ${e?.message ?? e}`);
  }

  // 3. Clean up worktree directory (provider-independent fallback --
  // ensures cleanup even when no compute is assigned or provider doesn't handle local worktrees)
  await removeSessionWorktree(app, session);

  // 3b. Clean up terminal recording file
  try {
    const { removeRecording } = await import("../recordings.js");
    removeRecording(app.config.arkDir, sessionId);
  } catch {
    logInfo("session", "non-fatal");
  }

  // 4. Soft-delete (keeps DB row for 90s undo window)
  await app.sessions.softDelete(sessionId);

  await app.events.log(sessionId, "session_deleted", { actor: "user" });

  return { ok: true, message: "Session deleted (undo available for 90s)" };
}

export async function undeleteSessionAsync(
  app: AppContext,
  sessionId: string,
): Promise<{ ok: boolean; message: string }> {
  const restored = await app.sessions.undelete(sessionId);
  if (!restored) return { ok: false, message: `Session ${sessionId} not found or not deleted` };

  await app.events.log(sessionId, "session_undeleted", { actor: "user" });

  return { ok: true, message: `Session restored (status: ${restored.status})` };
}

/** Clean up provider resources when a session reaches a terminal state (completed/failed). */
export async function cleanupOnTerminal(app: AppContext, sessionId: string): Promise<void> {
  const session = await app.sessions.get(sessionId);
  if (!session) return;
  await withProvider(session, `cleanup ${sessionId}`, (p, c) => p.cleanupSession(c, session));
  // Tenant-level claude creds Secret cleanup -- idempotent.
  try {
    const compute = session.compute_name ? await app.computes.get(session.compute_name) : null;
    await deletePerSessionCredsSecret(app, session, compute);
  } catch (e: any) {
    logError("session", `cleanupOnTerminal ${sessionId}: creds secret cleanup: ${e?.message ?? e}`);
  }
}

/** Wait for a session to reach a terminal state. Returns the final session. */
export async function waitForCompletion(
  app: AppContext,
  sessionId: string,
  opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
): Promise<{ session: Session | null; timedOut: boolean }> {
  const timeout = opts?.timeoutMs ?? 0; // 0 = no timeout
  const pollMs = opts?.pollMs ?? 3000;
  const start = Date.now();

  while (true) {
    const session = await app.sessions.get(sessionId);
    if (!session) return { session: null, timedOut: false };

    const terminal = ["completed", "failed", "stopped"].includes(session.status);
    if (terminal) return { session, timedOut: false };

    opts?.onStatus?.(session.status);

    if (timeout > 0 && Date.now() - start > timeout) {
      return { session, timedOut: true };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
