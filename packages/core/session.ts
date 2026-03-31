/**
 * Session lifecycle - start, dispatch, advance, stop, resume, clone, handoff, fork/join.
 *
 * This is the main orchestration module. All session state mutations go through here.
 * Direct interaction with the store is for reads only - writes go through these functions.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { homedir } from "os";

const execFileAsync = promisify(execFile);

import * as store from "./store.js";
import { getCompute } from "./store.js";
import * as tmux from "./tmux.js";
import * as flow from "./flow.js";
import * as agentRegistry from "./agent.js";
import * as claude from "./claude.js";
import { parseTranscriptUsage } from "./claude.js";
import { getProvider } from "../compute/index.js";

export type SessionOpResult = { ok: true; sessionId: string } | { ok: false; message: string };
import { resolvePortDecls, parseArcJson } from "../compute/arc-json.js";
import { buildSessionVars } from "./template.js";
import { resolveFlow } from "./flow.js";
import { loadRepoConfig } from "./repo-config.js";
import { eventBus } from "./hooks.js";
import { indexSession } from "./search.js";
import type { OutboundMessage } from "./channel-types.js";

// ── Session lifecycle ───────────────────────────────────────────────────────

/** Resolve GitHub repo URL from a local git directory. Returns null if not a GitHub repo. */
function resolveGitHubUrl(dir?: string | null): string | null {
  if (!dir) return null;
  try {
    const { execFileSync } = require("child_process");
    const remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 5_000,
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
      console.error("resolveGitHubUrl:", msg);
    }
    return null;
  }
}

export function startSession(opts: {
  ticket?: string;
  summary?: string;
  repo?: string;
  flow?: string;
  compute_name?: string;
  workdir?: string;
  group_name?: string;
  config?: Record<string, unknown>;
}): store.Session {
  const repoDir = opts.workdir ?? opts.repo;
  const repoConfig = repoDir ? loadRepoConfig(repoDir) : {};

  const mergedOpts = {
    ...opts,
    flow: opts.flow ?? repoConfig.flow,
    compute_name: opts.compute_name ?? repoConfig.compute,
    group_name: opts.group_name ?? repoConfig.group,
  };

  // Resolve GitHub repo URL from git remote
  const repoUrl = resolveGitHubUrl(opts.workdir ?? opts.repo);
  if (repoUrl) {
    mergedOpts.config = { ...(mergedOpts.config ?? {}), github_url: repoUrl };
  }

  const session = store.createSession(mergedOpts);

  // Set first stage
  const firstStage = flow.getFirstStage(mergedOpts.flow ?? "default");
  if (firstStage) {
    const action = flow.getStageAction(mergedOpts.flow ?? "default", firstStage);
    store.updateSession(session.id, { stage: firstStage, status: "ready" });
    store.logEvent(session.id, "stage_ready", {
      stage: firstStage, actor: "system",
      data: { stage: firstStage, gate: "auto", stage_type: action.type, stage_agent: action.agent },
    });
  }
  return store.getSession(session.id)!;
}

export async function dispatch(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<{ ok: boolean; message: string }> {
  const log = opts?.onLog ?? (() => {});
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  if (session.status === "running" && session.session_id) {
    return { ok: true, message: `Already running (${session.session_id})` };
  }
  if (session.status !== "ready" && session.status !== "blocked") {
    return { ok: false, message: `Not ready (status: ${session.status})` };
  }

  const stage = session.stage;
  if (!stage) return { ok: false, message: "No current stage" };

  // Validate compute exists if specified
  if (session.compute_name) {
    const compute = store.getCompute(session.compute_name);
    if (!compute) {
      return { ok: false, message: `Compute '${session.compute_name}' not found. Delete and recreate the session.` };
    }
  }

  // Check if fork stage
  const stageDef = flow.getStage(session.flow, stage);
  if (stageDef?.type === "fork") {
    return dispatchFork(sessionId, stageDef);
  }

  const action = flow.getStageAction(session.flow, stage);
  if (action.type !== "agent") {
    return { ok: false, message: `Stage '${stage}' is ${action.type}, not agent` };
  }

  const agentName = action.agent!;
  log(`Resolving agent: ${agentName}`);
  const projectRoot = agentRegistry.findProjectRoot(session.workdir || session.repo) ?? undefined;
  const agent = agentRegistry.resolveAgent(agentName, session as unknown as Record<string, unknown>, projectRoot);
  if (!agent) return { ok: false, message: `Agent '${agentName}' not found` };

  // Resolve autonomy level from flow stage definition
  const autonomy = stageDef?.autonomy ?? "full";

  // Build task with handoff context
  log("Building task...");
  const task = await buildTaskWithHandoff(session, stage, agentName);
  const claudeArgs = agentRegistry.buildClaudeArgs(agent, { autonomy });

  // Launch in tmux
  log("Launching agent...");
  const tmuxName = await launchAgentTmux(session, stage, claudeArgs, task, agent, { autonomy, onLog: log });

  store.updateSession(sessionId, { status: "running", agent: agentName, session_id: tmuxName });
  store.logEvent(sessionId, "stage_started", {
    stage, actor: "user",
    data: {
      agent: agentName, session_id: tmuxName, model: agent.model,
      tools: agent.tools, skills: agent.skills, memories: agent.memories,
      task_preview: task.slice(0, 200),
    },
  });

  return { ok: true, message: tmuxName };
}

export function advance(sessionId: string, force = false): { ok: boolean; message: string } {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const { flow: flowName, stage } = session;
  if (!stage) return { ok: false, message: "No current stage" };

  if (!force) {
    const { canProceed, reason } = flow.evaluateGate(flowName, stage, session);
    if (!canProceed) return { ok: false, message: reason };
  }

  const nextStage = flow.getNextStage(flowName, stage);
  if (!nextStage) {
    // Flow complete
    store.updateSession(sessionId, { status: "completed" });
    store.logEvent(sessionId, "session_completed", {
      stage, actor: "system",
      data: { final_stage: stage, flow: flowName },
    });
    // Auto-clear unread badge so completed sessions don't show stale notifications
    store.markMessagesRead(sessionId);
    return { ok: true, message: "Flow completed" };
  }

  const nextAction = flow.getStageAction(flowName, nextStage);
  store.updateSession(sessionId, { stage: nextStage, status: "ready", error: null });
  store.logEvent(sessionId, "stage_ready", {
    stage: nextStage, actor: "system",
    data: {
      from_stage: stage, to_stage: nextStage,
      stage_type: nextAction.type, stage_agent: nextAction.agent,
      forced: force,
    },
  });

  return { ok: true, message: `Advanced to ${nextStage}` };
}

export async function stop(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // Kill agent via provider
  const { provider, compute } = resolveProvider(session);
  if (provider && compute) {
    await provider.killAgent(compute, session);
  } else if (session.session_id) {
    // Fallback: direct tmux kill (no compute assigned)
    await tmux.killSessionAsync(session.session_id);
  }

  // Clean up hook config from working directory
  if (session.workdir) {
    try { claude.removeHooksConfig(session.workdir); } catch (e: any) {
      console.error(`stop: removeHooksConfig failed for ${sessionId}:`, e?.message ?? e);
    }
  }

  // Preserve claude_session_id so restart can --resume the conversation
  store.updateSession(sessionId, { status: "stopped", error: null, session_id: null });
  store.logEvent(sessionId, "session_stopped", {
    stage: session.stage, actor: "user",
    data: { session_id: session.session_id, agent: session.agent },
  });
  return { ok: true, message: "Session stopped" };
}

export async function resume(sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<{ ok: boolean; message: string }> {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status === "running" && session.session_id) return { ok: false, message: "Already running" };

  if (session.session_id) await tmux.killSessionAsync(session.session_id);

  store.updateSession(sessionId, {
    status: "ready", error: null, breakpoint_reason: null,
    attached_by: null, session_id: null,
  });
  store.logEvent(sessionId, "session_resumed", {
    stage: session.stage, actor: "user",
    data: { from_status: session.status },
  });

  // Auto re-dispatch
  return await dispatch(sessionId, opts);
}

export function complete(sessionId: string): { ok: boolean; message: string } {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  store.logEvent(sessionId, "stage_completed", {
    stage: session.stage, actor: "user",
    data: { note: "Manually completed" },
  });
  store.markMessagesRead(sessionId);
  store.updateSession(sessionId, { status: "ready", session_id: null });
  return advance(sessionId, true);
}

export function pause(sessionId: string, reason?: string): { ok: boolean; message: string } {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  store.updateSession(sessionId, { status: "blocked", breakpoint_reason: reason ?? "User paused" });
  store.logEvent(sessionId, "session_paused", {
    stage: session.stage, actor: "user",
    data: { reason, was_status: session.status },
  });
  return { ok: true, message: "Paused" };
}

// ── Review gate ─────────────────────────────────────────────────────────────

/** Open a review gate — called when PR is approved via webhook. */
export function approveReviewGate(sessionId: string): { ok: boolean; message: string } {
  const s = store.getSession(sessionId);
  if (!s) return { ok: false, message: "Session not found" };

  store.logEvent(sessionId, "review_approved", {
    stage: s.stage ?? undefined, actor: "github",
  });

  // Force-advance past the review gate
  return advance(sessionId, true);
}

// ── Clone & Handoff ─────────────────────────────────────────────────────────

/**
 * Fork: shallow copy - same compute, repo, flow, group. Fresh session, no resume.
 */
export function forkSession(sessionId: string, newName?: string): SessionOpResult {
  const original = store.getSession(sessionId);
  if (!original) return { ok: false, message: `Session ${sessionId} not found` };

  const baseName = original.summary || sessionId;
  const fork = store.createSession({
    ticket: original.ticket || undefined,
    summary: newName ?? `${baseName} (fork)`,
    repo: original.repo || undefined,
    flow: original.flow,
    compute_name: original.compute_name || undefined,
    workdir: original.workdir || undefined,
  });

  store.updateSession(fork.id, {
    stage: original.stage,
    status: "ready",
    group_name: original.group_name,
  });

  store.logEvent(fork.id, "session_forked", {
    stage: original.stage, actor: "user",
    data: { forked_from: sessionId },
  });

  return { ok: true, sessionId: fork.id };
}

/**
 * Clone: deep copy - same as fork PLUS claude_session_id for --resume.
 * The new session will resume the same Claude conversation.
 */
export function cloneSession(sessionId: string, newName?: string): SessionOpResult {
  const original = store.getSession(sessionId);
  if (!original) return { ok: false, message: `Session ${sessionId} not found` };

  const baseName = original.summary || sessionId;
  const clone = store.createSession({
    ticket: original.ticket || undefined,
    summary: newName ?? `${baseName} (clone)`,
    repo: original.repo || undefined,
    flow: original.flow,
    compute_name: original.compute_name || undefined,
    workdir: original.workdir || undefined,
  });

  store.updateSession(clone.id, {
    stage: original.stage,
    status: "ready",
    group_name: original.group_name,
    claude_session_id: original.claude_session_id, // --resume handoff
  });

  store.logEvent(clone.id, "session_cloned", {
    stage: original.stage, actor: "user",
    data: { cloned_from: sessionId, claude_session_id: original.claude_session_id },
  });

  return { ok: true, sessionId: clone.id };
}

export async function handoff(sessionId: string, toAgent: string, instructions?: string): Promise<{ ok: boolean; message: string }> {
  const result = cloneSession(sessionId, instructions);
  if (!result.ok) return { ok: false, message: result.message };

  store.logEvent(result.sessionId, "session_handoff", {
    actor: "user",
    data: { from_session: sessionId, to_agent: toAgent, instructions },
  });

  return await dispatch(result.sessionId);
}

// ── Fork/Join ───────────────────────────────────────────────────────────────

export function fork(parentId: string, task: string, opts?: {
  agent?: string;
  dispatch?: boolean;
}): SessionOpResult {
  const parent = store.getSession(parentId);
  if (!parent) return { ok: false, message: "Parent not found" };

  const forkGroup = parent.fork_group ?? randomUUID().slice(0, 8);
  if (!parent.fork_group) store.updateSession(parentId, { fork_group: forkGroup });

  const child = store.createSession({
    ticket: parent.ticket || undefined,
    summary: task,
    repo: parent.repo || undefined,
    flow: "bare",
    compute_name: parent.compute_name || undefined,
    workdir: parent.workdir || undefined,
  });

  store.updateSession(child.id, {
    parent_id: parentId, fork_group: forkGroup,
    stage: parent.stage, status: "ready",
  });
  store.logEvent(child.id, "session_forked", {
    stage: parent.stage, actor: "user",
    data: { parent_id: parentId, fork_group: forkGroup, task },
  });

  if (opts?.dispatch !== false) {
    void dispatch(child.id);
  }
  return { ok: true, sessionId: child.id };
}

function dispatchFork(sessionId: string, stageDef: flow.StageDefinition): { ok: boolean; message: string } {
  // Read PLAN.md or use default subtasks
  const session = store.getSession(sessionId)!;
  const subtasks = extractSubtasks(session);

  const children: string[] = [];
  for (const sub of subtasks.slice(0, stageDef.max_parallel ?? 4)) {
    const result = fork(sessionId, sub.task, { dispatch: true });
    if (result.ok) children.push(result.sessionId);
  }

  store.updateSession(sessionId, { status: "running" });
  store.logEvent(sessionId, "fork_started", {
    stage: session.stage, actor: "system",
    data: { children_count: children.length, children },
  });

  return { ok: true, message: `Forked into ${children.length} sessions` };
}

export function joinFork(parentId: string, force = false): { ok: boolean; message: string } {
  const children = store.getChildren(parentId);
  if (!children.length) return { ok: false, message: "No children" };

  const notDone = children.filter((c) => c.status !== "completed");
  if (notDone.length && !force) {
    return { ok: false, message: `${notDone.length} children not done` };
  }

  store.logEvent(parentId, "fork_joined", { actor: "user", data: { children: children.length } });
  store.updateSession(parentId, { status: "ready", fork_group: null });
  return advance(parentId, true);
}

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * Fully delete a session: kill agent, clean up provider resources, clean
 * hooks, delete DB rows. All provider-specific logic delegated to the provider.
 */
export async function deleteSessionAsync(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const { provider, compute } = resolveProvider(session);

  // 1. Kill agent process via provider
  if (provider && compute) {
    try { await provider.killAgent(compute, session); } catch (e: any) {
      console.error(`deleteSession: killAgent failed for ${sessionId}:`, e?.message ?? e);
    }
  } else if (session.session_id) {
    await tmux.killSessionAsync(session.session_id);
  }

  // 2. Clean up hook config
  if (session.workdir) {
    try { claude.removeHooksConfig(session.workdir); } catch (e: any) {
      // Cleanup best-effort: workdir may already be deleted
      console.error(`deleteSession: removeHooksConfig failed for ${sessionId}:`, e?.message ?? e);
    }
  }

  // 3. Provider-specific session cleanup (worktree, remote checkout, container stop)
  if (provider && compute) {
    try { await provider.cleanupSession(compute, session); } catch (e: any) {
      console.error(`deleteSession: cleanupSession failed for ${sessionId}:`, e?.message ?? e);
    }
  }

  // 4. Delete DB rows (instant)
  store.deleteSession(sessionId);

  return { ok: true, message: "Session deleted" };
}

// ── Provider resolution ──────────────────────────────────────────────────────

import type { ComputeProvider } from "../compute/types.js";

/** Resolve the compute provider for a session via AppContext. */
function resolveProvider(session: store.Session): { provider: ComputeProvider | null; compute: store.Compute | null } {
  try {
    const { getApp } = require("./app.js");
    return getApp().resolveProvider(session);
  } catch {
    // Expected: AppContext not booted (e.g. CLI mode) — resolve manually
    const computeName = session.compute_name ?? "local";
    const compute = store.getCompute(computeName);
    if (!compute) return { provider: null, compute: null };
    const { getProvider } = require("../compute/index.js");
    return { provider: getProvider(compute.provider) ?? null, compute };
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

/** Setup git worktree + Claude trust for the session working directory. */
async function setupSessionWorktree(
  session: store.Session,
  compute: store.Compute | null,
  provider: ComputeProvider | undefined,
  onLog?: (msg: string) => void,
): Promise<string> {
  const log = onLog ?? (() => {});
  const workdir = session.workdir ?? ".";
  let effectiveWorkdir = workdir;

  const wantWorktree = provider?.supportsWorktree && session.config?.worktree !== false;
  if (wantWorktree && workdir !== "." && existsSync(join(workdir, ".git"))) {
    log("Setting up git worktree...");
    const wt = await setupWorktree(workdir, session.id, session.branch ?? undefined);
    if (wt) effectiveWorkdir = wt;
  }

  // Trust worktree for Claude
  log("Configuring Claude trust + channel...");
  claude.trustWorktree(workdir, effectiveWorkdir);

  return effectiveWorkdir;
}

/** Prepare remote compute: connectivity check, env sync, docker/devcontainer setup. */
async function prepareRemoteEnvironment(
  session: store.Session,
  compute: store.Compute,
  provider: ComputeProvider,
  effectiveWorkdir: string,
  opts?: { launchContent?: string; onLog?: (msg: string) => void },
): Promise<{ finalLaunchContent: string; ports: any[] }> {
  const log = opts?.onLog ?? (() => {});
  let finalLaunchContent = opts?.launchContent ?? "";

  // Auto-start stopped computes
  if (compute.status === "stopped") {
    log(`Starting compute '${compute.name}'...`);
    await provider.start(compute);
  }

  // Verify host is reachable before starting expensive sync/clone chain
  const ip = (compute.config as any)?.ip;
  if (ip) {
    log("Checking host connectivity...");
    const { sshExecAsync, sshKeyPath } = await import("../compute/providers/ec2/ssh.js");
    const { exitCode } = await sshExecAsync(sshKeyPath(compute.name), ip, "echo ok", { timeout: 15_000 });
    if (exitCode !== 0) {
      throw new Error(`Cannot reach compute '${compute.name}' at ${ip}`);
    }
  }

  // Resolve ports from arc.json / devcontainer / compose
  const ports = effectiveWorkdir ? resolvePortDecls(effectiveWorkdir) : [];

  // Store ports on session config
  if (ports.length > 0) {
    store.updateSession(session.id, {
      config: { ...session.config, ports },
    });
  }

  // Sync environment to compute
  log("Syncing credentials...");
  try {
    const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
    await provider.syncEnvironment(compute, {
      direction: "push",
      projectFiles: arcJson?.sync,
      projectDir: effectiveWorkdir,
      onLog: log,
    });
  } catch (e: any) { log(`Credential sync failed (continuing): ${e?.message ?? e}`); }

  // Docker Compose - only when explicitly enabled in arc.json { "compose": true }
  if (effectiveWorkdir) {
    const arcJson = parseArcJson(effectiveWorkdir);
    if (arcJson?.compose === true && compute.config?.ip) {
      log("Starting Docker Compose services...");
      const { sshExec, sshKeyPath } = await import("../compute/providers/ec2/ssh.js");
      sshExec(sshKeyPath(compute.name), compute.config.ip as string,
        `cd ${effectiveWorkdir} && docker compose up -d`);
    }
  }

  // Devcontainer - only used when explicitly enabled in arc.json { "devcontainer": true }
  if (effectiveWorkdir) {
    const arcJson = parseArcJson(effectiveWorkdir);
    if (arcJson?.devcontainer === true) {
      log("Building devcontainer...");
      const { buildLaunchCommand } = await import("../compute/providers/docker/devcontainer.js");
      finalLaunchContent = buildLaunchCommand(effectiveWorkdir, finalLaunchContent);
    }
  }

  return { finalLaunchContent, ports };
}

async function launchAgentTmux(
  session: store.Session, stage: string,
  claudeArgs: string[], task: string, agent: agentRegistry.AgentDefinition,
  opts?: { autonomy?: string; onLog?: (msg: string) => void },
): Promise<string> {
  const log = opts?.onLog ?? (() => {});
  const tmuxName = `ark-${session.id}`;

  // Resolve compute + provider
  const compute = session.compute_name ? store.getCompute(session.compute_name) : null;
  const provider = getProvider(compute?.provider ?? "local");

  // Setup worktree + trust
  const effectiveWorkdir = await setupSessionWorktree(session, compute, provider, log);

  // Determine conductor URL based on compute type
  const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
  const usesDevcontainer = arcJson?.devcontainer ?? false;
  const conductorUrl = usesDevcontainer
    ? "http://host.docker.internal:19100"
    : "http://localhost:19100";

  // Channel config + launcher
  const channelPort = store.sessionChannelPort(session.id);
  const channelConfig = provider?.buildChannelConfig(session.id, stage, channelPort, { conductorUrl });
  const mcpConfigPath = claude.writeChannelConfig(session.id, stage, channelPort, effectiveWorkdir, { conductorUrl, channelConfig });

  // Status hooks — write .claude/settings.local.json for agent status detection
  claude.writeHooksConfig(session.id, conductorUrl, effectiveWorkdir, { autonomy: opts?.autonomy });

  // Build launch env from agent config + provider-specific env (e.g. auth tokens for remote)
  const launchEnv = { ...(agent.env ?? {}), ...(provider?.buildLaunchEnv(session as any) ?? {}) };

  const { content: launchContent, claudeSessionId } = claude.buildLauncher({
    workdir: effectiveWorkdir,
    claudeArgs,
    mcpConfigPath,
    prevClaudeSessionId: session.claude_session_id,
    sessionName: session.summary ?? session.id,
    env: launchEnv,
  });

  const launcher = tmux.writeLauncher(session.id, launchContent);

  // Save task for reference
  const sessionDir = join(store.TRACKS_DIR(), session.id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "task.txt"), task);

  // Remote compute (providers that don't support local worktrees)
  if (compute && provider && !provider.supportsWorktree) {
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

    store.updateSession(session.id, { claude_session_id: claudeSessionId });

    // Deliver task via channel (tunnels are now up, channel port is accessible locally)
    log("Delivering task...");
    claude.deliverTask(session.id, channelPort, task, stage);

    return result;
  }

  // Local launch
  log("Starting local tmux session...");
  await tmux.createSessionAsync(tmuxName, `bash ${launcher}`);
  claude.autoAcceptChannelPrompt(tmuxName);
  log("Delivering task...");
  claude.deliverTask(session.id, channelPort, task, stage);
  store.updateSession(session.id, { claude_session_id: claudeSessionId });

  return tmuxName;
}

async function buildTaskWithHandoff(session: store.Session, stage: string, agentName: string): Promise<string> {
  const parts: string[] = [];
  const isBare = session.flow === "bare";

  // Get resolved stage with substituted variables
  const vars = buildSessionVars(session as unknown as Record<string, unknown>);
  const resolved = resolveFlow(session.flow, vars);
  const stageDef = resolved?.stages.find(s => s.name === stage);

  // If stage has a task template, use it as the primary prompt
  if (stageDef?.task) {
    parts.push(stageDef.task);
    parts.push(`\nYou are the ${agentName} agent, running the '${stage}' stage.`);
  } else if (isBare) {
    // Bare flow: interactive session — no predefined task pipeline
    parts.push(`Session ${session.id}${session.summary ? ` — ${session.summary}` : ""}`);
    parts.push(`\nYou are the ${agentName} agent in an interactive session.`);
    parts.push(`You will receive instructions from the user via steer messages.`);
  } else {
    parts.push(`Work on ${session.ticket ?? session.id}: ${session.summary ?? "the task"}`);
    parts.push(`\nYou are the ${agentName} agent, running the '${stage}' stage.`);
  }

  // Readiness + completion reporting
  parts.push(`\nWhen you start up, immediately call the \`report\` tool with type='progress' to announce you are online and ready for work.`);
  parts.push(`When you finish your work, call \`report\` with type='completed' and a concise summary of what you accomplished (files changed, tests added, key decisions). This summary is shown to the user in the dashboard.`);

  // Previous stage context
  const events = store.getEvents(session.id);
  const completed = events.filter((e) => e.type === "stage_completed");
  if (completed.length) {
    parts.push("\n## Previous stages:");
    for (const c of completed) {
      const d = c.data ?? {};
      parts.push(`- ${c.stage} (agent=${d.agent ?? "?"}, turns=${d.num_turns ?? "?"}, cost=$${d.cost_usd ?? 0})`);
    }
  }

  // Check for PLAN.md
  const wtDir = join(store.WORKTREES_DIR(), session.id);
  const planPath = join(wtDir, "PLAN.md");
  if (existsSync(planPath)) {
    let plan = readFileSync(planPath, "utf-8");
    if (plan.length > 3000) plan = plan.slice(0, 3000) + "\n... (truncated)";
    parts.push(`\n## PLAN.md:\n${plan}`);
  }

  // Git log
  if (existsSync(wtDir)) {
    try {
      const { stdout: log } = await execFileAsync("git", ["-C", wtDir, "log", "--oneline", "-10", "--no-decorate"], {
        encoding: "utf-8",
      });
      if (log.trim()) parts.push(`\n## Recent commits:\n${log.trim()}`);
    } catch {
      // Expected: worktree dir may not be a git repo yet
    }
  }

  return parts.join("\n");
}

function extractSubtasks(session: store.Session): { name: string; task: string }[] {
  const wtDir = join(store.WORKTREES_DIR(), session.id);
  const planPath = join(wtDir, "PLAN.md");

  if (existsSync(planPath)) {
    const plan = readFileSync(planPath, "utf-8");
    const steps = [...plan.matchAll(/^##\s+(?:Step\s+)?(\d+)[.:]\s*(.+)/gm)];
    if (steps.length >= 2) {
      return steps.map(([, num, title]) => ({
        name: `step-${num}`,
        task: `Step ${num}: ${title.trim()}. Follow PLAN.md.`,
      }));
    }
  }

  const summary = session.summary ?? "the task";
  return [
    { name: "implementation", task: `Implement: ${summary}` },
    { name: "tests", task: `Write tests for: ${summary}` },
  ];
}

async function setupWorktree(repoPath: string, sessionId: string, branch?: string): Promise<string | null> {
  const wtPath = join(store.WORKTREES_DIR(), sessionId);
  if (existsSync(wtPath)) return wtPath;

  const branchName = branch ?? `ark-${sessionId}`;
  try {
    await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], { stdio: "pipe" });
    // Try with new branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", branchName, wtPath], { stdio: "pipe" });
      return wtPath;
    } catch (e: any) {
      if (!String(e).includes("already exists")) {
        console.error(`setupWorktree: new branch '${branchName}' failed:`, e?.message ?? e);
      }
    }
    // Try existing branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", wtPath, branchName], { stdio: "pipe" });
      return wtPath;
    } catch (e: any) {
      if (!String(e).includes("already checked out") && !String(e).includes("already exists")) {
        console.error(`setupWorktree: existing branch '${branchName}' failed:`, e?.message ?? e);
      }
    }
    // Unique branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", `ark-${sessionId}`, wtPath], { stdio: "pipe" });
      return wtPath;
    } catch (e: any) {
      console.error(`setupWorktree: all worktree strategies failed for ${sessionId}:`, e?.message ?? e);
    }
  } catch (e: any) {
    console.error(`setupWorktree: worktree prune failed:`, e?.message ?? e);
  }
  return null;
}

// ── Wait ────────────────────────────────────────────────────────────────

/** Wait for a session to reach a terminal state. Returns the final session. */
export async function waitForCompletion(
  sessionId: string,
  opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
): Promise<{ session: store.Session; timedOut: boolean }> {
  const timeout = opts?.timeoutMs ?? 0; // 0 = no timeout
  const pollMs = opts?.pollMs ?? 3000;
  const start = Date.now();

  while (true) {
    const session = store.getSession(sessionId);
    if (!session) return { session: null as any, timedOut: false };

    const terminal = ["completed", "failed", "stopped"].includes(session.status);
    if (terminal) return { session, timedOut: false };

    opts?.onStatus?.(session.status);

    if (timeout > 0 && Date.now() - start > timeout) {
      return { session, timedOut: true };
    }

    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ── Output ──────────────────────────────────────────────────────────────────

export async function getOutput(sessionId: string, opts?: { lines?: number; ansi?: boolean }): Promise<string> {
  const session = store.getSession(sessionId);
  if (!session?.session_id) return "";

  const { provider, compute } = resolveProvider(session);
  if (provider && compute) {
    return provider.captureOutput(compute, session, opts);
  }
  return "";
}

export async function send(sessionId: string, message: string): Promise<{ ok: boolean; message: string }> {
  const session = store.getSession(sessionId);
  if (!session?.session_id) return { ok: false, message: "No active session" };
  await tmux.sendTextAsync(session.session_id, message);
  return { ok: true, message: "Sent" };
}

// ── Hook status logic (extracted from conductor) ─────────────────────────────

export interface HookStatusResult {
  newStatus?: string;
  shouldIndex?: boolean;
  claudeSessionId?: string;
  /** Store updates to apply */
  updates?: Partial<store.Session>;
  /** Events to log */
  events?: Array<{ type: string; opts: { actor?: string; stage?: string; data?: Record<string, unknown> } }>;
  /** Usage data parsed from transcript */
  usage?: { total_tokens: number; [key: string]: unknown };
  /** Transcript indexing info */
  indexTranscript?: { transcriptPath: string; sessionId: string };
}

/**
 * Pure business logic for processing a hook status event.
 * Determines status transitions, events to log, and side effects
 * without touching the store or event bus directly.
 */
export function applyHookStatus(
  session: store.Session,
  hookEvent: string,
  payload: Record<string, unknown>,
): HookStatusResult {
  const result: HookStatusResult = { events: [] };

  // Check if this session uses manual gate (interactive - user controls lifecycle)
  const stageDef = session.stage ? flow.getStage(session.flow, session.stage) : null;
  const isManualGate = stageDef?.gate === "manual";

  const statusMap: Record<string, string> = {
    SessionStart: "running",
    UserPromptSubmit: "running",
    StopFailure: isManualGate ? "running" : "failed",
    SessionEnd: isManualGate ? "running" : "completed",
  };

  let newStatus = statusMap[hookEvent];

  // Don't override completed/failed status — late hooks can fire after session is done
  if (newStatus && session.status === "completed" && newStatus !== "completed") {
    newStatus = undefined;
  }
  if (newStatus && session.status === "failed" && newStatus === "running") {
    newStatus = undefined;
  }

  if (hookEvent === "Notification") {
    const matcher = String(payload.matcher ?? "");
    if (matcher.includes("permission_prompt") || matcher.includes("idle_prompt")) {
      newStatus = "waiting";
    }
  }

  // Always log the hook event
  result.events!.push({
    type: "hook_status",
    opts: { actor: "hook", data: { event: hookEvent, ...payload } as Record<string, unknown> },
  });

  // For manual gate: log errors/completions as events but don't change status
  if (isManualGate && (hookEvent === "StopFailure" || hookEvent === "SessionEnd")) {
    const errorMsg = payload.error ?? payload.error_details;
    if (errorMsg) {
      result.events!.push({
        type: "agent_error",
        opts: { actor: "agent", data: { error: String(errorMsg), event: hookEvent } },
      });
    }
  }

  if (newStatus) {
    const updates: Partial<store.Session> = { status: newStatus as any };
    if (newStatus === "failed") {
      updates.error = String(payload.error ?? payload.error_details ?? "unknown error");
    }
    // Clear stale breakpoint when resuming from waiting
    if (newStatus === "running" && session.status === "waiting") {
      updates.breakpoint_reason = null;
    }
    result.updates = updates;
    result.newStatus = newStatus;
  }

  // Track token usage from transcript on Stop and SessionEnd
  const transcriptPath = payload.transcript_path as string | undefined;
  if (transcriptPath && (hookEvent === "Stop" || hookEvent === "SessionEnd")) {
    try {
      const usage = parseTranscriptUsage(transcriptPath);
      if (usage.total_tokens > 0) {
        result.usage = usage;
      }
    } catch (e: any) { console.error("transcript parsing failed:", e?.message ?? e); }

    // Index transcript for FTS5 search — only if the transcript belongs to THIS session's agent
    const hookClaudeSession = payload.session_id as string | undefined;
    if (hookClaudeSession && session.claude_session_id &&
        transcriptPath.includes(hookClaudeSession)) {
      result.shouldIndex = true;
      result.indexTranscript = { transcriptPath, sessionId: session.id };
    }
  }

  return result;
}

// ── Report handling logic (extracted from conductor) ─────────────────────────

export interface ReportResult {
  /** Store updates to apply to the session */
  updates: Partial<store.Session>;
  /** Whether to call session.advance() after applying updates */
  shouldAdvance?: boolean;
  /** Whether to auto-dispatch next stage after advance */
  shouldAutoDispatch?: boolean;
  /** Events to emit on the event bus */
  busEvents?: Array<{ type: string; sessionId: string; data: Record<string, unknown> }>;
  /** Events to log to the store */
  logEvents?: Array<{ type: string; opts: { stage?: string; actor?: string; data?: Record<string, unknown> } }>;
  /** Message to store for TUI chat view */
  message?: { role: string; content: string; type: string };
  /** PR URL detected from report */
  prUrl?: string;
}

/**
 * Pure business logic for processing an agent channel report.
 * Determines state transitions, messages, and events without
 * touching the store, event bus, or session lifecycle directly.
 */
export function applyReport(sessionId: string, report: OutboundMessage): ReportResult {
  const session = store.getSession(sessionId);
  const result: ReportResult = { updates: {}, logEvents: [], busEvents: [] };

  // Log event
  result.logEvents!.push({
    type: `agent_${report.type}`,
    opts: {
      stage: report.stage,
      actor: "agent",
      data: report as unknown as Record<string, unknown>,
    },
  });

  // Build message content for TUI chat view
  const r = report as Record<string, unknown>;
  const contentByType: Record<string, string | undefined> = {
    completed: (r.summary || r.message) as string | undefined,
    question:  (r.question || r.message) as string | undefined,
    error:     (r.error || r.message) as string | undefined,
    progress:  (r.message || r.summary) as string | undefined,
  };
  let content = contentByType[report.type] || JSON.stringify(report);

  // Enrich with files, commits, PR URL when available
  const extras: string[] = [];
  if (r.pr_url) extras.push(`PR: ${r.pr_url}`);
  if (Array.isArray(r.filesChanged) && r.filesChanged.length > 0) {
    extras.push(`Files: ${(r.filesChanged as string[]).join(", ")}`);
  }
  if (Array.isArray(r.commits) && r.commits.length > 0) {
    extras.push(`Commits: ${(r.commits as string[]).join(", ")}`);
  }
  if (extras.length > 0) content += "\n" + extras.join("\n");
  result.message = { role: "agent", content, type: report.type };

  // Emit to event bus
  result.busEvents!.push({
    type: `agent_${report.type}`,
    sessionId,
    data: { stage: report.stage, data: report as unknown as Record<string, unknown> },
  });

  // Handle by type
  switch (report.type) {
    case "completed": {
      // Save completion data to session config for display in detail pane
      if (session) {
        const cfg = {
          ...(session.config as any),
          completion_summary: (report as any).summary,
          filesChanged: (report as any).filesChanged,
          commits: (report as any).commits,
        };
        result.updates.config = cfg;
      }

      // Check gate type — manual gates keep session running (user decides when done)
      const stageDef = session ? flow.getStage(session.flow, session.stage ?? "") : null;
      const isManualGate = stageDef?.gate === "manual";

      if (isManualGate) {
        // Manual gate: agent completed its task but session stays running
        result.logEvents!.push({
          type: "agent_completed",
          opts: {
            stage: session?.stage ?? undefined,
            actor: "agent",
            data: { summary: (report as any).summary },
          },
        });
        // Don't change status — session stays running, agent stays alive
      } else {
        // Auto gate: advance to next stage or complete the session
        result.updates.status = "ready";
        result.updates.session_id = null;
        result.shouldAdvance = true;
        result.shouldAutoDispatch = true;
      }
      break;
    }
    case "question":
      result.updates.status = "waiting";
      result.updates.breakpoint_reason =
        (report as any).question ?? (report as any).message;
      break;
    case "error":
      result.updates.status = "failed";
      result.updates.error = (report as any).error ?? (report as any).message;
      break;
    case "progress": {
      // Agent is actively reporting — ensure status reflects that.
      if (session && session.status === "waiting") {
        result.updates.status = "running";
        result.updates.breakpoint_reason = null;
      }
      break;
    }
  }

  // PR URL from agent report
  const prUrl = (report as any).pr_url as string | undefined;
  if (prUrl && session && !session.pr_url) {
    result.prUrl = prUrl;
  }

  return result;
}
