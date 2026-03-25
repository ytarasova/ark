/**
 * Session lifecycle - start, dispatch, advance, stop, resume, clone, handoff, fork/join.
 *
 * This is the main orchestration module. All session state mutations go through here.
 * Direct interaction with the store is for reads only - writes go through these functions.
 */

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
import { getProvider } from "../compute/index.js";
import { resolvePortDecls, parseArcJson } from "../compute/arc-json.js";
import { buildSessionVars } from "./template.js";
import { resolveFlow } from "./flow.js";
import { loadRepoConfig } from "./repo-config.js";

// ── Session lifecycle ───────────────────────────────────────────────────────

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

export async function dispatch(sessionId: string): Promise<{ ok: boolean; message: string }> {
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
  const agent = agentRegistry.resolveAgent(agentName, session as unknown as Record<string, unknown>);
  if (!agent) return { ok: false, message: `Agent '${agentName}' not found` };

  // Resolve autonomy level from flow stage definition
  const autonomy = stageDef?.autonomy ?? "full";

  // Build task with handoff context
  const task = await buildTaskWithHandoff(session, stage, agentName);
  const claudeArgs = agentRegistry.buildClaudeArgs(agent, { autonomy });

  // Launch in tmux
  const tmuxName = await launchAgentTmux(session, stage, claudeArgs, task, agent, { autonomy });

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
    try { claude.removeHooksConfig(session.workdir); } catch {}
  }

  // Preserve claude_session_id so restart can --resume the conversation
  store.updateSession(sessionId, { status: "stopped", error: null, session_id: null });
  store.logEvent(sessionId, "session_stopped", {
    stage: session.stage, actor: "user",
    data: { session_id: session.session_id, agent: session.agent },
  });
  return { ok: true, message: "Session stopped" };
}

export async function resume(sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status === "running" && session.session_id) return { ok: false, message: "Already running" };
  if (session.status === "completed") return { ok: false, message: "Session already completed — clone it instead" };

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
  return await dispatch(sessionId);
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

export function cloneSession(sessionId: string, newTask?: string): { ok: boolean; cloneId: string } {
  const original = store.getSession(sessionId);
  if (!original) return { ok: false, cloneId: `Session ${sessionId} not found` };

  const clone = store.createSession({
    ticket: original.ticket || undefined,
    summary: newTask ?? `Clone of ${original.summary ?? sessionId}`,
    repo: original.repo || undefined,
    flow: original.flow,
    compute_name: original.compute_name || undefined,
    workdir: original.workdir || undefined,
  });

  store.updateSession(clone.id, {
    stage: original.stage,
    status: "ready",
    claude_session_id: original.claude_session_id, // --resume handoff
  });

  store.logEvent(clone.id, "session_cloned", {
    stage: original.stage, actor: "user",
    data: { cloned_from: sessionId, claude_session_id: original.claude_session_id },
  });

  return { ok: true, cloneId: clone.id };
}

export async function handoff(sessionId: string, toAgent: string, instructions?: string): Promise<{ ok: boolean; message: string }> {
  const { ok, cloneId } = cloneSession(sessionId, instructions);
  if (!ok) return { ok: false, message: cloneId };

  store.logEvent(cloneId, "session_handoff", {
    actor: "user",
    data: { from_session: sessionId, to_agent: toAgent, instructions },
  });

  return await dispatch(cloneId);
}

// ── Fork/Join ───────────────────────────────────────────────────────────────

export function fork(parentId: string, task: string, opts?: {
  agent?: string;
  dispatch?: boolean;
}): { ok: boolean; childId: string } {
  const parent = store.getSession(parentId);
  if (!parent) return { ok: false, childId: "Parent not found" };

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
  return { ok: true, childId: child.id };
}

function dispatchFork(sessionId: string, stageDef: flow.StageDefinition): { ok: boolean; message: string } {
  // Read PLAN.md or use default subtasks
  const session = store.getSession(sessionId)!;
  const subtasks = extractSubtasks(session);

  const children: string[] = [];
  for (const sub of subtasks.slice(0, stageDef.max_parallel ?? 4)) {
    const { ok, childId } = fork(sessionId, sub.task, { dispatch: true });
    if (ok) children.push(childId);
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
    try { await provider.killAgent(compute, session); } catch {}
  } else if (session.session_id) {
    await tmux.killSessionAsync(session.session_id);
  }

  // 2. Clean up hook config
  if (session.workdir) {
    try { claude.removeHooksConfig(session.workdir); } catch {}
  }

  // 3. Provider-specific session cleanup (worktree, remote checkout, container stop)
  if (provider && compute) {
    try { await provider.cleanupSession(compute, session); } catch {}
  }

  // 4. Delete DB rows (instant)
  store.deleteSession(sessionId);

  return { ok: true, message: "Session deleted" };
}

// ── Provider resolution ──────────────────────────────────────────────────────

import type { ComputeProvider } from "../compute/types.js";

/** Resolve the compute provider for a session via AppContext. */
function resolveProvider(session: store.Session): { provider: ComputeProvider | null; compute: store.Compute | null } {
  const { getApp } = require("./app.js");
  return getApp().resolveProvider(session);
}

// ── Internal ────────────────────────────────────────────────────────────────

async function launchAgentTmux(
  session: store.Session, stage: string,
  claudeArgs: string[], task: string, agent: agentRegistry.AgentDefinition,
  opts?: { autonomy?: string },
): Promise<string> {
  const tmuxName = `ark-${session.id}`;
  const workdir = session.workdir ?? ".";

  // Setup worktree — only for local compute with git repos
  let effectiveWorkdir = workdir;
  const compute = session.compute_name ? store.getCompute(session.compute_name) : null;
  const isLocal = !compute || compute.provider === "local";
  const wantWorktree = isLocal && session.config?.worktree !== false;
  if (wantWorktree && workdir !== "." && existsSync(join(workdir, ".git"))) {
    const wt = await setupWorktree(workdir, session.id, session.branch ?? undefined);
    if (wt) effectiveWorkdir = wt;
  }

  // Trust worktree for Claude
  claude.trustWorktree(workdir, effectiveWorkdir);

  // Determine conductor URL based on compute type
  const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
  const usesDevcontainer = arcJson?.devcontainer ?? false;
  const conductorUrl = usesDevcontainer
    ? "http://host.docker.internal:19100"
    : "http://localhost:19100";

  // Channel config + launcher
  const channelPort = store.sessionChannelPort(session.id);
  const mcpConfigPath = claude.writeChannelConfig(session.id, stage, channelPort, effectiveWorkdir, { conductorUrl });

  // Status hooks — write .claude/settings.local.json for agent status detection
  claude.writeHooksConfig(session.id, conductorUrl, effectiveWorkdir, { autonomy: opts?.autonomy });

  const { content: launchContent, claudeSessionId } = claude.buildLauncher({
    workdir: effectiveWorkdir,
    claudeArgs,
    mcpConfigPath,
    prevClaudeSessionId: session.claude_session_id,
    sessionName: session.summary ?? session.id,
    env: agent.env,
  });

  let finalLaunchContent = launchContent;
  const launcher = tmux.writeLauncher(session.id, launchContent);

  // Save task for reference
  const sessionDir = join(store.TRACKS_DIR(), session.id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "task.txt"), task);

  // Check for remote compute
  if (compute && compute.provider !== "local") {
    const provider = getProvider(compute.provider);
    if (!provider) {
      return tmuxName; // fallback to local if provider not found
    }

    // Auto-start stopped computes
    if (compute.status === "stopped") {
      await provider.start(compute);
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
    try {
      const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
      await provider.syncEnvironment(compute, {
        direction: "push",
        projectFiles: arcJson?.sync,
        projectDir: effectiveWorkdir,
      });
    } catch { /* sync failure shouldn't block launch */ }

    // Docker Compose - only when explicitly enabled in arc.json { "compose": true }
    if (effectiveWorkdir) {
      const arcJson = parseArcJson(effectiveWorkdir);
      if (arcJson?.compose === true && compute.config?.ip) {
        const { sshExec, sshKeyPath } = await import("../compute/providers/ec2/ssh.js");
        sshExec(sshKeyPath(compute.name), compute.config.ip as string,
          `cd ${effectiveWorkdir} && docker compose up -d`);
      }
    }

    // Devcontainer - only used when explicitly enabled in arc.json { "devcontainer": true }
    if (effectiveWorkdir) {
      const arcJson = parseArcJson(effectiveWorkdir);
      if (arcJson?.devcontainer === true) {
        const { buildLaunchCommand } = await import("../compute/providers/docker/devcontainer.js");
        finalLaunchContent = buildLaunchCommand(effectiveWorkdir, finalLaunchContent);
      }
    }

    // Launch via provider
    const result = await provider.launch(compute, session, {
      tmuxName,
      workdir: effectiveWorkdir,
      launcherContent: finalLaunchContent,
      ports,
    });

    return result;
  }

  // Local launch
  await tmux.createSessionAsync(tmuxName, `bash ${launcher}`);
  claude.autoAcceptChannelPrompt(tmuxName);
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
    } catch { /* ignore */ }
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
    } catch { /* branch exists */ }
    // Try existing branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", wtPath, branchName], { stdio: "pipe" });
      return wtPath;
    } catch { /* checked out elsewhere */ }
    // Unique branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", `ark-${sessionId}`, wtPath], { stdio: "pipe" });
      return wtPath;
    } catch { /* give up */ }
  } catch { /* ignore */ }
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
  // Fallback: direct tmux capture (async)
  return tmux.capturePaneAsync(session.session_id, opts);
}

export async function send(sessionId: string, message: string): Promise<{ ok: boolean; message: string }> {
  const session = store.getSession(sessionId);
  if (!session?.session_id) return { ok: false, message: "No active session" };
  await tmux.sendTextAsync(session.session_id, message);
  return { ok: true, message: "Sent" };
}
