/**
 * Session lifecycle - start, dispatch, advance, stop, resume, clone, handoff, fork/join.
 *
 * This is the main orchestration module. All session state mutations go through here.
 * Direct interaction with the store is for reads only - writes go through these functions.
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

import type { AppContext } from "../app.js";
import type { Session, Compute, MessageRole, MessageType } from "../../types/index.js";
import * as tmux from "../infra/tmux.js";
import * as flow from "../state/flow.js";
import type { FlowDefinition } from "../state/flow.js";
import * as agentRegistry from "../agent/agent.js";
import * as claude from "../claude/claude.js";
import { getProvider } from "../../compute/index.js";

export type SessionOpResult = { ok: true; sessionId: string } | { ok: false; message: string };
import { resolvePortDecls, parseArcJson } from "../../compute/arc-json.js";
import { buildSessionVars } from "../template.js";
import { resolveFlow } from "../state/flow.js";
import { loadRepoConfig } from "../repo-config.js";
import type { OutboundMessage } from "../conductor/channel-types.js";
import { safeAsync } from "../safe.js";
import { saveCheckpoint } from "../session/checkpoint.js";
import { profileGroupPrefix } from "../state/profiles.js";
import { parseGraphFlow, getSuccessors, resolveNextStages, computeSkippedStages } from "../state/graph-flow.js";
import { evaluateTermination, parseTermination, type TerminationContext } from "../termination.js";
import { markStageCompleted, setCurrentStage, markStagesSkipped, getSkippedStages, loadFlowState } from "../state/flow-state.js";
// memory.ts removed -- knowledge graph context injection handles memory/learning recall
import { detectHandoff } from "../handoff.js";
import { filterMessages, parseMessageFilter } from "../message-filter.js";
import { logError, logWarn } from "../observability/structured-log.js";
import { recordEvent } from "../observability.js";
import { track } from "../observability/telemetry.js";
import { emitSessionSpanStart, emitSessionSpanEnd, emitStageSpanStart, emitStageSpanEnd, flushSpans } from "../observability/otlp.js";
import { detectInjection } from "../session/prompt-guard.js";
import { generateRepoMap, formatRepoMap } from "../repo-map.js";
import { getExecutor } from "../executor.js";
import type { ComputeProvider } from "../../compute/types.js";
import { resolveProvider } from "../provider-registry.js";

const DEFAULT_BASE_BRANCH = "main";

/** Ingest nodes/edges from a remote arkd /codegraph/index response into the knowledge store. */
function ingestRemoteIndex(app: AppContext, data: any, log: (msg: string) => void): void {
  const addedFiles = new Set<string>();
  for (const node of data.nodes ?? []) {
    if (node.file && !addedFiles.has(node.file)) {
      app.knowledge.addNode({
        id: `file:${node.file}`,
        type: "file",
        label: node.file,
        metadata: { language: node.file.split(".").pop() ?? "unknown" },
      });
      addedFiles.add(node.file);
    }
    app.knowledge.addNode({
      id: `symbol:${node.file}::${node.name}`,
      type: "symbol",
      label: node.name,
      metadata: { kind: node.kind, file: node.file, line_start: node.line, line_end: node.end_line, exported: node.exported === 1 },
    });
  }
  for (const edge of data.edges ?? []) {
    const srcNode = (data.nodes ?? []).find((n: any) => n.id === edge.source_id);
    const tgtNode = (data.nodes ?? []).find((n: any) => n.id === edge.target_id);
    if (srcNode && tgtNode) {
      app.knowledge.addEdge(
        `symbol:${srcNode.file}::${srcNode.name}`,
        `symbol:${tgtNode.file}::${tgtNode.name}`,
        edge.kind === "imports" ? "imports" : "depends_on",
      );
    }
  }
  log(`Remote index: ${addedFiles.size} files, ${(data.nodes ?? []).length} symbols`);
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
    const model = (session.config?.model as string | undefined)
      ?? runtime?.default_model
      ?? "sonnet";

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

/** Convert a typed Session to a plain Record for template variable resolution. */
function sessionAsVars(session: Session): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(session)) rec[k] = v;
  return rec;
}

// ── Session lifecycle ───────────────────────────────────────────────────────

/** Resolve GitHub repo URL from a local git directory. Returns null if not a GitHub repo. */
function resolveGitHubUrl(dir?: string | null): string | null {
  if (!dir) return null;
  try {
    const remote = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf-8", timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe"],
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

export function startSession(app: AppContext, opts: {
  ticket?: string;
  summary?: string;
  repo?: string;
  flow?: string;
  agent?: string | null;
  compute_name?: string;
  workdir?: string;
  group_name?: string;
  config?: Record<string, unknown>;
}): Session {
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
  };

  // Resolve GitHub repo URL from git remote
  const repoUrl = resolveGitHubUrl(opts.workdir ?? opts.repo);
  if (repoUrl) {
    mergedOpts.config = { ...(mergedOpts.config ?? {}), github_url: repoUrl };
  }

  const session = app.sessions.create(mergedOpts);

  // Telemetry: track session creation
  track("session_created", { flow: mergedOpts.flow ?? "default" });

  // Apply agent override if specified
  if (opts.agent) {
    app.sessions.update(session.id, { agent: opts.agent });
  }

  // Set first stage
  const firstStage = flow.getFirstStage(app,mergedOpts.flow ?? "default");
  if (firstStage) {
    const action = flow.getStageAction(app,mergedOpts.flow ?? "default", firstStage);
    app.sessions.update(session.id, { stage: firstStage, status: "ready" });
    app.events.log(session.id, "stage_ready", {
      stage: firstStage, actor: "system",
      data: { stage: firstStage, gate: "auto", stage_type: action.type, stage_agent: action.agent },
    });

    emitSessionSpanStart(session.id, {
      flow: mergedOpts.flow ?? "default",
      repo: opts.repo,
      agent: opts.agent ?? undefined,
    });
    if (firstStage) {
      const stageAction = flow.getStageAction(app,mergedOpts.flow ?? "default", firstStage);
      emitStageSpanStart(session.id, { stage: firstStage, agent: stageAction.agent, gate: "auto" });
    }
  }
  return app.sessions.get(session.id)!;
}

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
    const cfgTmpl = (app.config.computeTemplates ?? []).find(t => t.name === templateName);
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

export async function dispatch(app: AppContext, sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<{ ok: boolean; message: string }> {
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

  // Hosted mode: delegate to scheduler which enforces tenant policies
  try {
    const scheduler = app.scheduler;
    // Scheduler is available -- we are in hosted mode
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
  } catch {
    // Scheduler not available -- fall through to local dispatch
  }

  // Handle remote repo: clone to local temp directory if no workdir set
  if (session.config?.remoteRepo && !session.workdir) {
    const remoteUrl = session.config.remoteRepo as string;
    log(`Cloning remote repo: ${remoteUrl}`);
    try {
      const tmpDir = join(app.arkDir, "worktrees", sessionId);
      mkdirSync(tmpDir, { recursive: true });
      await execFileAsync("git", ["clone", "--depth", "1", remoteUrl, tmpDir], { timeout: 120_000 });
      app.sessions.update(sessionId, { workdir: tmpDir });
      // Re-fetch session to pick up workdir
      const updated = app.sessions.get(sessionId);
      if (updated) {
        // Copy updated fields into session reference for the rest of dispatch
        (session as { workdir: string | null }).workdir = updated.workdir;
      }
      log(`Cloned remote repo to ${tmpDir}`);
      app.events.log(sessionId, "remote_repo_cloned", {
        actor: "system", data: { url: remoteUrl, dir: tmpDir },
      });
    } catch (e: any) {
      return { ok: false, message: `Failed to clone remote repo: ${e.message}` };
    }
  }

  // Check task summary for prompt injection
  try {
    const injection = detectInjection(session.summary ?? "");
    if (injection.severity === "high") {
      app.events.log(sessionId, "prompt_injection_blocked", {
        actor: "system", data: { patterns: injection.patterns, context: "dispatch" },
      });
      return { ok: false, message: "Dispatch blocked: potential prompt injection in task summary" };
    }
    if (injection.detected) {
      app.events.log(sessionId, "prompt_injection_warning", {
        actor: "system", data: { patterns: injection.patterns, severity: injection.severity, context: "dispatch" },
      });
    }
  } catch { /* skip guard on error */ }

  // Check if fork stage
  const stageDef = flow.getStage(app,session.flow, stage);

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

  const action = flow.getStageAction(app,session.flow, stage);
  if (action.type !== "agent") {
    return { ok: false, message: `Stage '${stage}' is ${action.type}, not agent` };
  }

  const agentName = action.agent!;
  log(`Resolving agent: ${agentName}`);
  const projectRoot = agentRegistry.findProjectRoot(session.workdir || session.repo) ?? undefined;

  // Resolve runtime override from session config (set by --runtime CLI flag)
  const runtimeOverride = session.config?.runtime_override as string | undefined;
  const agent = agentRegistry.resolveAgentWithRuntime(app, agentName, sessionAsVars(session), { runtimeOverride, projectRoot });
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

  // Index codebase into knowledge graph
  if (session.repo) {
    const repoPath = session.workdir ?? session.repo;
    const compute = session.compute_name ? app.computes.get(session.compute_name) : null;
    const computeIp = compute?.config?.ip as string | undefined;

    if (computeIp) {
      // Remote compute -- ALWAYS index via arkd (control plane needs centralized knowledge)
      const arkdPort = (compute?.config?.arkd_port as number | undefined) ?? 19300;
      const arkdUrl = `http://${computeIp}:${arkdPort}`;
      try {
        log("Indexing codebase on remote...");
        const resp = await fetch(`${arkdUrl}/codegraph/index`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoPath, incremental: true }),
        });
        if (resp.ok) {
          const data = await resp.json() as { ok?: boolean; files?: number; symbols?: number; error?: string };
          ingestRemoteIndex(app, data, log);
        }
      } catch (e: any) {
        log(`Remote index failed: ${e.message}`);
      }
    } else if (app.config.knowledge?.autoIndex) {
      // Local compute -- index if autoIndex is enabled
      try {
        const { indexCodebase } = await import("../knowledge/indexer.js");
        const existingFiles = app.knowledge.listNodes({ type: "file", limit: 1 });
        if (existingFiles.length === 0) {
          log("Auto-indexing codebase...");
          await indexCodebase(repoPath, app.knowledge);
        } else if (app.config.knowledge.incrementalIndex) {
          log("Incremental index...");
          await indexCodebase(repoPath, app.knowledge, { incremental: true });
        }
      } catch (e: any) {
        log(`Auto-index skipped: ${e.message}`);
      }
    }
  }

  // Inject knowledge graph context (memories, learnings, related sessions, files)
  if (app.knowledge) {
    try {
      const { buildContext, formatContextAsMarkdown } = await import("../knowledge/context.js");
      const ctx = buildContext(app.knowledge, task, {
        repo: session.repo ?? undefined,
        sessionId: session.id,
      });
      const contextMd = formatContextAsMarkdown(ctx);
      if (contextMd) {
        task = contextMd + task;
      }
    } catch { /* knowledge not available -- continue without context */ }
  }

  // Inject repo map into agent context for codebase awareness
  if (session.repo) {
    try {
      const repoMap = generateRepoMap(session.workdir ?? session.repo, { maxFiles: 200 });
      if (repoMap.entries.length > 0) {
        const mapStr = formatRepoMap(repoMap.entries, 1500);
        task = task + `\n\n## Repository Structure\n\`\`\`\n${mapStr}\n\`\`\`\n`;
      }
    } catch { /* skip repo map on error */ }
  }

  // Resolve executor -- use resolved runtime type (from RuntimeStore merge), fall back to agent.runtime, then claude-code.
  // Reads through app.pluginRegistry, the canonical source for extensible collections.
  const runtime = agent._resolved_runtime_type ?? agent.runtime ?? "claude-code";
  const executor = app.pluginRegistry.executor(runtime) ?? getExecutor(runtime);
  if (!executor) return { ok: false, message: `Executor '${runtime}' not registered` };

  // Build claude args (only for claude-code executor)
  const claudeArgs = runtime === "claude-code" ? agentRegistry.buildClaudeArgs(agent, { autonomy, projectRoot, app }) : [];

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
    compute: session.compute_name ? (app.computes.get(session.compute_name) as unknown as { name: string; provider: string; [k: string]: unknown } | null) ?? undefined : undefined,
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
        cwd: session.workdir, encoding: "utf-8", timeout: 5000,
      }).trim();
    } catch { /* no git -- skip */ }
  }

  app.sessions.update(sessionId, { status: "running", agent: agentName, session_id: tmuxName });
  if (stageStartSha) {
    app.sessions.mergeConfig(sessionId, { stage_start_sha: stageStartSha });
  }
  app.events.log(sessionId, "stage_started", {
    stage, actor: "user",
    data: {
      agent: agentName, session_id: tmuxName, model: agent.model,
      tools: agent.tools, skills: agent.skills, memories: agent.memories,
      task_preview: task.slice(0, 200),
      stage_start_sha: stageStartSha,
    },
  });

  // Persist flow state: mark current stage
  try { setCurrentStage(app, sessionId, session.stage!, session.flow); } catch { /* skip flow-state on error */ }

  // Checkpoint after successful dispatch
  saveCheckpoint(app, sessionId);

  // Start status poller for ALL runtimes as a crash detection fallback.
  // Claude uses hook-based status but hooks don't fire when the agent crashes
  // (e.g. MCP config error, OOM, segfault). The poller detects tmux session exit.
  try {
    const { startStatusPoller } = await import("../executors/status-poller.js");
    startStatusPoller(app, sessionId, tmuxName, runtime);
  } catch { /* ignore */ }

  // Observability + telemetry
  recordEvent({ type: "session_start", sessionId, data: { agent: session.agent ?? agentName, flow: session.flow } });
  track("session_dispatched", { agent: agentName });

  return { ok: true, message: tmuxName };
}

export async function advance(app: AppContext, sessionId: string, force = false, outcome?: string): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const { flow: flowName, stage } = session;
  if (!stage) return { ok: false, message: "No current stage. The session may have completed its flow." };

  if (!force) {
    const { canProceed, reason } = flow.evaluateGate(app,flowName, stage, session);
    if (!canProceed) return { ok: false, message: reason };
  }

  // Checkpoint before advancing to next stage
  saveCheckpoint(app, sessionId);

  // Observability: track stage advancement
  recordEvent({ type: "agent_turn", sessionId, data: { stage } });

  // Graph flow routing: if flow definition has edges, use DAG conditional routing
  try {
    const flowDef = app.flows.get(flowName);
    const hasDependsOn = flowDef?.stages?.some(s => s.depends_on?.length > 0);
    if (flowDef && (flowDef.edges?.length > 0 || hasDependsOn)) {
      const graphFlow = parseGraphFlow(flowDef);
      const flowState = loadFlowState(app, sessionId);
      const completedStages = flowState?.completedStages ?? [];
      const skippedStages = flowState?.skippedStages ?? [];

      // Resolve next stages with conditional routing and join barrier awareness
      const readyStages = resolveNextStages(
        graphFlow, stage, session.config ?? {},
        completedStages, skippedStages,
      );

      if (readyStages.length > 0) {
        // Mark current stage completed
        try { markStageCompleted(app, sessionId, stage); } catch { /* skip */ }

        // Compute which stages should be skipped due to conditional branching
        const allSuccessors = getSuccessors(graphFlow, stage);
        if (allSuccessors.length > 1) {
          const newSkipped = computeSkippedStages(graphFlow, stage, readyStages, skippedStages);
          if (newSkipped.length > skippedStages.length) {
            try { markStagesSkipped(app, sessionId, newSkipped); } catch { /* skip */ }
          }
        }

        // Advance to the first ready stage (additional ready stages will be
        // picked up on subsequent advance() calls if the flow has parallel branches)
        const graphNextStage = readyStages[0];
        try { setCurrentStage(app, sessionId, graphNextStage, flowName); } catch { /* skip */ }

        // Stage isolation: clear runtime handles so next stage gets a fresh runtime.
        // If the next stage has isolation="continue", preserve claude_session_id for --resume.
        const graphNextStageDef = flow.getStage(app, flowName, graphNextStage);
        const graphIsolation = graphNextStageDef?.isolation ?? "fresh";
        const graphSessionUpdates: Partial<Session> = { stage: graphNextStage, status: "ready", session_id: null };
        if (graphIsolation === "fresh") {
          graphSessionUpdates.claude_session_id = null;
        }
        app.sessions.update(sessionId, graphSessionUpdates);
        app.events.log(sessionId, "stage_advanced", {
          actor: "system", stage: graphNextStage,
          data: { via: "graph-flow-conditional", readyStages, skippedStages: flowState?.skippedStages ?? [], isolation: graphIsolation },
        });
        emitStageSpanEnd(sessionId, { status: "completed" });
        const graphAction = flow.getStageAction(app, flowName, graphNextStage);
        const graphStageDef = flow.getStage(app, flowName, graphNextStage);
        emitStageSpanStart(sessionId, { stage: graphNextStage, agent: graphAction?.agent, gate: graphStageDef?.gate });
        saveCheckpoint(app, sessionId);
        return { ok: true, message: `Advanced to ${graphNextStage} (graph-flow)` };
      }

      // No ready stages -- check if this is because join barriers aren't met
      // or because we've reached a terminal node
      const allSuccessors = getSuccessors(graphFlow, stage, session.config ?? {});
      if (allSuccessors.length > 0) {
        // Successors exist but aren't ready (join barriers) -- mark completed and wait
        try { markStageCompleted(app, sessionId, stage); } catch { /* skip */ }
        app.sessions.update(sessionId, { status: "waiting" });
        app.events.log(sessionId, "stage_waiting", {
          actor: "system", stage,
          data: { via: "graph-flow-conditional", waiting_for: allSuccessors, reason: "join-barrier" },
        });
        return { ok: true, message: `Stage ${stage} completed, waiting for join barrier` };
      }

      // Terminal node -- flow complete
      try { markStageCompleted(app, sessionId, stage); } catch { /* skip */ }
      app.sessions.update(sessionId, { status: "completed" });
      app.events.log(sessionId, "session_completed", {
        stage, actor: "system",
        data: { final_stage: stage, flow: flowName, via: "graph-flow-conditional" },
      });
      app.messages.markRead(sessionId);
      emitStageSpanEnd(sessionId, { status: "completed" });
      const s = app.sessions.get(sessionId);
      const agg = app.usageRecorder.getSessionCost(sessionId);
      emitSessionSpanEnd(sessionId, {
        status: "completed",
        tokens_in: agg.input_tokens, tokens_out: agg.output_tokens, tokens_cache: agg.cache_read_tokens,
        cost_usd: agg.cost, turns: s?.config?.turns as number | undefined,
      });
      flushSpans();
      return { ok: true, message: "Flow completed (graph-flow)" };
    }
  } catch { /* graph flow not applicable, fall through to linear */ }

  const nextStage = flow.resolveNextStage(app, flowName, stage, outcome);
  if (!nextStage) {
    // Flow complete -- persist final stage completion
    try { markStageCompleted(app, sessionId, stage, outcome ? { outcome } : undefined); } catch { /* skip */ }
    app.sessions.update(sessionId, { status: "completed" });
    app.events.log(sessionId, "session_completed", {
      stage, actor: "system",
      data: { final_stage: stage, flow: flowName },
    });
    // Auto-clear unread badge so completed sessions don't show stale notifications
    app.messages.markRead(sessionId);

    emitStageSpanEnd(sessionId, { status: "completed" });
    const s = app.sessions.get(sessionId);
    const agg = app.usageRecorder.getSessionCost(sessionId);
    emitSessionSpanEnd(sessionId, {
      status: "completed",
      tokens_in: agg.input_tokens, tokens_out: agg.output_tokens, tokens_cache: agg.cache_read_tokens,
      cost_usd: agg.cost, turns: s?.config?.turns as number | undefined,
    });
    flushSpans();

    // Extract skills from completed session transcript
    try {
      const { extractAndSaveSkills } = await import("../agent/skill-extractor.js");
      const { getSessionConversation } = await import("../search/search.js");
      const conv = getSessionConversation(app, sessionId);
      if (conv.length > 0) {
        const turns = conv.map((c) => ({ role: c.role === "message" ? "user" : "assistant", content: c.content }));
        extractAndSaveSkills(sessionId, turns, app);
      }
    } catch { /* skill extraction is best-effort */ }

    return { ok: true, message: "Flow completed" };
  }

  // Persist flow state: mark completed + set next
  try { markStageCompleted(app, sessionId, stage, outcome ? { outcome } : undefined); } catch { /* skip */ }
  try { setCurrentStage(app, sessionId, nextStage, flowName); } catch { /* skip */ }

  const nextAction = flow.getStageAction(app,flowName, nextStage);

  // Stage isolation: clear runtime handles so next stage gets a fresh runtime.
  // Default is "fresh" -- each stage starts with a clean slate.
  // If the next stage has isolation="continue", preserve claude_session_id for --resume.
  const nextStageDef = flow.getStage(app, flowName, nextStage);
  const isolation = nextStageDef?.isolation ?? "fresh";
  const sessionUpdates: Partial<Session> = { stage: nextStage, status: "ready", error: null, session_id: null };
  if (isolation === "fresh") {
    sessionUpdates.claude_session_id = null;
  }
  app.sessions.update(sessionId, sessionUpdates);

  app.events.log(sessionId, "stage_ready", {
    stage: nextStage, actor: "system",
    data: {
      from_stage: stage, to_stage: nextStage,
      stage_type: nextAction.type, stage_agent: nextAction.agent,
      forced: force,
      isolation,
      ...(outcome ? { outcome, via: "on_outcome" } : {}),
    },
  });

  emitStageSpanEnd(sessionId, { status: "completed" });
  emitStageSpanStart(sessionId, { stage: nextStage, agent: nextAction?.agent, gate: nextStageDef?.gate });

  // Checkpoint after advancing to new stage
  saveCheckpoint(app, sessionId);

  return { ok: true, message: `Advanced to ${nextStage}` };
}

export async function stop(app: AppContext, sessionId: string, opts?: { force?: boolean }): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
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
  } catch { /* fall through to tmux kill */ }

  // Kill agent + clean up provider resources FIRST (before any DB writes)
  // This ensures processes are stopped even if subsequent DB ops fail
  const stopped = await withProvider(session, `stop ${sessionId}`, async (p, c) => {
    await p.killAgent(c, session);
    await p.cleanupSession(c, session);
  });
  if (!stopped && session.session_id) {
    // Fallback: kill via launcher (no compute assigned)
    await app.launcher.kill(session.session_id);
  }

  // Stop status poller if active (non-Claude executors)
  try {
    const { stopStatusPoller } = await import("../executors/status-poller.js");
    stopStatusPoller(sessionId);
  } catch { /* ignore */ }

  // Checkpoint before state transition
  saveCheckpoint(app, sessionId);

  // Clean up hook config and channel MCP config from working directory
  if (session.workdir) {
    try { claude.removeSettings(session.workdir); } catch (e: any) {
      logError("session", `stop ${sessionId}: removeSettings: ${e?.message ?? e}`);
    }
    try { claude.removeChannelConfig(session.workdir); } catch (e: any) {
      logError("session", `stop ${sessionId}: removeChannelConfig: ${e?.message ?? e}`);
    }
  }

  // Clean up worktree directory (provider-independent -- ensures cleanup even
  // when no compute is assigned or provider doesn't handle local worktrees)
  await removeSessionWorktree(app, session);

  // Preserve claude_session_id so restart can --resume the conversation
  app.sessions.update(sessionId, { status: "stopped", error: null, session_id: null });
  app.events.log(sessionId, "session_stopped", {
    stage: session.stage, actor: "user",
    data: { session_id: session.session_id, agent: session.agent },
  });

  // Observability: track session stop
  recordEvent({ type: "session_end", sessionId, data: { status: "stopped" } });

  emitStageSpanEnd(sessionId, { status: "stopped" });
  emitSessionSpanEnd(sessionId, { status: "stopped" });
  flushSpans();

  return { ok: true, message: "Session stopped" };
}

export async function resume(app: AppContext, sessionId: string, opts?: { onLog?: (msg: string) => void }): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status === "running" && session.session_id) return { ok: false, message: "Already running" };

  if (session.session_id) await app.launcher.kill(session.session_id);

  app.sessions.update(sessionId, {
    status: "ready", error: null, breakpoint_reason: null,
    attached_by: null, session_id: null,
  });
  app.events.log(sessionId, "session_resumed", {
    stage: session.stage, actor: "user",
    data: { from_status: session.status },
  });

  // Auto re-dispatch
  return await dispatch(app, sessionId, opts);
}

/**
 * Run verification for a session: check todos are resolved and verify scripts pass.
 * Returns structured results for display and enforcement.
 */
export async function runVerification(app: AppContext, sessionId: string): Promise<{
  ok: boolean;
  todosResolved: boolean;
  pendingTodos: string[];
  scriptResults: Array<{ script: string; passed: boolean; output: string }>;
  message: string;
}> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, todosResolved: true, pendingTodos: [], scriptResults: [], message: "Session not found" };

  // Check todos
  const todos = app.todos.list(sessionId);
  const pending = todos.filter(t => !t.done);
  const todosResolved = pending.length === 0;

  // Determine verify scripts from flow stage + repo config
  const stageVerify = session.stage && session.flow
    ? flow.getStage(app,session.flow, session.stage)?.verify
    : undefined;
  const repoConfig = session.workdir ? loadRepoConfig(session.workdir) : {};
  const scripts: string[] = stageVerify ?? repoConfig.verify ?? [];

  // Run each script in the session workdir
  const workdir = session.workdir ?? session.repo;
  const scriptResults: Array<{ script: string; passed: boolean; output: string }> = [];
  for (const script of scripts) {
    try {
      const { stdout, stderr } = await execFileAsync("bash", ["-c", script], {
        cwd: workdir ?? undefined,
        encoding: "utf-8",
        timeout: 120_000,
      });
      scriptResults.push({ script, passed: true, output: ((stdout ?? "") + (stderr ?? "")).slice(0, 5000) });
    } catch (e: any) {
      const output = ((e?.stderr ?? "") + (e?.stdout ?? "") + (e?.message ?? "")).slice(0, 5000);
      scriptResults.push({ script, passed: false, output });
    }
  }

  const allScriptsPassed = scriptResults.every(r => r.passed);
  const ok = todosResolved && allScriptsPassed;

  // Build human-readable message
  const parts: string[] = [];
  if (!todosResolved) parts.push(`${pending.length} unresolved todo(s): ${pending.map(t => t.content).join(", ")}`);
  for (const r of scriptResults) {
    if (!r.passed) parts.push(`verify failed: ${r.script}\n${r.output}`);
  }

  return {
    ok,
    todosResolved,
    pendingTodos: pending.map(t => t.content),
    scriptResults,
    message: ok ? "Verification passed" : parts.join("\n"),
  };
}

/**
 * Execute an action stage (create_pr, merge, close, etc.).
 * Called by the conductor when auto-advancing into an action stage.
 */
export async function executeAction(app: AppContext, sessionId: string, action: string): Promise<{ ok: boolean; message: string }> {
  const s = app.sessions.get(sessionId);
  if (!s) return { ok: false, message: "Session not found" };

  switch (action) {
    case "create_pr": {
      // Skip if we already know about a PR
      if (s.pr_url) {
        app.events.log(sessionId, "action_executed", { stage: s.stage ?? undefined, actor: "system", data: { action, pr_url: s.pr_url, skipped: "pr_already_exists" } });
        return await advance(app, sessionId, true);
      }
      // Also check if a PR exists on the branch (agent may have created one without reporting pr_url)
      if (s.branch && s.workdir) {
        try {
          const { stdout: prUrl } = await execFileAsync("gh", ["pr", "view", s.branch, "--json", "url", "-q", ".url"], {
            cwd: s.workdir, encoding: "utf-8", timeout: 10_000,
          });
          if (prUrl?.trim()) {
            const url = prUrl.trim();
            app.sessions.update(sessionId, { pr_url: url });
            app.events.log(sessionId, "action_executed", { stage: s.stage ?? undefined, actor: "system", data: { action, pr_url: url, skipped: "pr_found_on_branch" } });
            return await advance(app, sessionId, true);
          }
        } catch { /* no PR exists for this branch -- proceed to create */ }
      }
      const result = await createWorktreePR(app, sessionId, { title: s.summary ?? undefined });
      if (result.ok) {
        app.events.log(sessionId, "action_executed", { stage: s.stage ?? undefined, actor: "system", data: { action, pr_url: result.pr_url } });
        return await advance(app, sessionId, true);
      }
      return result;
    }
    case "merge_pr":
    case "merge": {
      const result = await finishWorktree(app, sessionId, { force: true });
      if (result.ok) {
        app.events.log(sessionId, "action_executed", { stage: s.stage ?? undefined, actor: "system", data: { action } });
      }
      return result;
    }
    case "auto_merge": {
      const result = await mergeWorktreePR(app, sessionId);
      if (result.ok) {
        app.events.log(sessionId, "action_executed", { stage: s.stage ?? undefined, actor: "system", data: { action, pr_url: s.pr_url ?? undefined } });
        // Don't advance yet -- gh pr merge --auto only queues the merge.
        // Transition to waiting; pr-merge-poller will advance once PR is actually merged.
        app.sessions.update(sessionId, {
          status: "waiting",
          breakpoint_reason: "Waiting for CI checks to pass and PR to merge",
          config: {
            ...(s.config ?? {}),
            merge_queued_at: new Date().toISOString(),
          },
        });
        app.events.log(sessionId, "merge_waiting", {
          stage: s.stage ?? undefined,
          actor: "system",
          data: { pr_url: s.pr_url ?? undefined, reason: "gh pr merge --auto queued, waiting for CI" },
        });
        return { ok: true, message: "Auto-merge queued -- waiting for CI to pass" };
      }
      return result;
    }
    case "close_ticket":
    case "close": {
      app.events.log(sessionId, "action_executed", { stage: s.stage ?? undefined, actor: "system", data: { action } });
      return await advance(app, sessionId, true);
    }
    default: {
      app.events.log(sessionId, "action_skipped", { stage: s.stage ?? undefined, actor: "system", data: { action, reason: "unknown action type" } });
      return await advance(app, sessionId, true);
    }
  }
}

export async function complete(app: AppContext, sessionId: string, opts?: { force?: boolean }): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // Run verification unless --force.
  // Quick sync check: only call async runVerification if there are todos or verify scripts.
  if (!opts?.force) {
    const hasTodos = app.todos.list(sessionId).length > 0;
    const stageVerify = session.stage && session.flow
      ? flow.getStage(app,session.flow, session.stage)?.verify
      : undefined;
    const repoVerify = session.workdir ? loadRepoConfig(session.workdir).verify : undefined;
    const hasScripts = (stageVerify ?? repoVerify ?? []).length > 0;

    if (hasTodos || hasScripts) {
      const verify = await runVerification(app, sessionId);
      if (!verify.ok) {
        return { ok: false, message: `Verification failed:\n${verify.message}` };
      }
    }
  }

  app.events.log(sessionId, "stage_completed", {
    stage: session.stage, actor: "user",
    data: { note: "Manually completed" },
  });
  app.messages.markRead(sessionId);

  // Parse agent transcript for token usage (non-Claude agents).
  // Claude usage is captured via hooks in applyHookStatus(); this handles codex/gemini.
  parseNonClaudeTranscript(app, session);

  app.sessions.update(sessionId, { status: "ready", session_id: null });
  return await advance(app, sessionId, true);
}

/**
 * Parse transcript for non-Claude agents on session completion.
 * Resolves the parser via AppContext's TranscriptParserRegistry and uses
 * workdir-based identification to find the exact file for this session.
 */
function parseNonClaudeTranscript(app: AppContext, session: Session): void {
  try {
    const runtimeName = (session.config?.runtime as string | undefined) ?? session.agent;
    if (!runtimeName) return;
    const runtime = app.runtimes.get(runtimeName);
    const parserKind = runtime?.billing?.transcript_parser;
    // Only handle non-Claude kinds here; Claude is handled via hooks in applyHookStatus
    if (!parserKind || parserKind === "claude") return;

    const parser = app.transcriptParsers.get(parserKind);
    if (!parser) {
      logError("session", "no transcript parser registered", { sessionId: session.id, kind: parserKind });
      return;
    }

    const workdir = session.workdir;
    if (!workdir) return;

    const transcriptPath = parser.findForSession({
      workdir,
      startTime: session.created_at ? new Date(session.created_at) : undefined,
    });
    if (!transcriptPath) return;

    const result = parser.parse(transcriptPath);
    if (result.usage.input_tokens > 0 || result.usage.output_tokens > 0) {
      const provider = parserKind === "codex" ? "openai" : parserKind === "gemini" ? "google" : parserKind;
      recordSessionUsage(app, session, result.usage, provider, "transcript");
    }
  } catch (e: any) {
    logError("session", "non-Claude transcript parsing failed", { sessionId: session.id, error: String(e?.message ?? e) });
  }
}

export function pause(app: AppContext, sessionId: string, reason?: string): { ok: boolean; message: string } {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  app.sessions.update(sessionId, { status: "blocked", breakpoint_reason: reason ?? "User paused" });
  app.events.log(sessionId, "session_paused", {
    stage: session.stage, actor: "user",
    data: { reason, was_status: session.status },
  });
  return { ok: true, message: "Paused" };
}

export async function archive(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // Stop if running
  if (session.session_id) {
    await app.launcher.kill(session.session_id);
  }

  app.sessions.update(sessionId, { status: "archived", session_id: null });
  app.events.log(sessionId, "session_archived", {
    stage: session.stage, actor: "user",
    data: { from_status: session.status },
  });
  return { ok: true, message: "Session archived" };
}

export function restore(app: AppContext, sessionId: string): { ok: boolean; message: string } {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status !== "archived") return { ok: false, message: `Session is ${session.status}, not archived` };

  app.sessions.update(sessionId, { status: "stopped" });
  app.events.log(sessionId, "session_restored", {
    stage: session.stage, actor: "user",
    data: {},
  });
  return { ok: true, message: "Session restored" };
}

export async function interrupt(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };
  if (session.status !== "running" && session.status !== "waiting") {
    return { ok: false, message: `Session is ${session.status}, not running` };
  }
  if (!session.session_id) return { ok: false, message: "No tmux session" };

  // Send Ctrl+C to interrupt the agent without killing the session
  await app.launcher.sendKeys(session.session_id, "C-c");

  app.sessions.update(sessionId, { status: "waiting" });
  app.events.log(sessionId, "session_interrupted", {
    stage: session.stage, actor: "user",
    data: { session_id: session.session_id },
  });

  return { ok: true, message: "Agent interrupted" };
}

// ── Review gate ─────────────────────────────────────────────────────────────

/** Open a review gate -- called when PR is approved via webhook. */
export async function approveReviewGate(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const s = app.sessions.get(sessionId);
  if (!s) return { ok: false, message: "Session not found" };

  app.events.log(sessionId, "review_approved", {
    stage: s.stage ?? undefined, actor: "github",
  });

  // Force-advance past the review gate
  return await advance(app, sessionId, true);
}

// ── Clone & Handoff ─────────────────────────────────────────────────────────

/**
 * Fork: shallow copy - same compute, repo, flow, group. Fresh session, no resume.
 */
export function forkSession(app: AppContext, sessionId: string, newName?: string): SessionOpResult {
  const original = app.sessions.get(sessionId);
  if (!original) return { ok: false, message: `Session ${sessionId} not found` };

  const baseName = original.summary || sessionId;
  const fork = app.sessions.create({
    ticket: original.ticket || undefined,
    summary: newName ?? `${baseName} (fork)`,
    repo: original.repo || undefined,
    flow: original.flow,
    compute_name: original.compute_name || undefined,
    workdir: original.workdir || undefined,
  });

  app.sessions.update(fork.id, {
    stage: original.stage,
    status: "ready",
    group_name: original.group_name,
  });

  app.events.log(fork.id, "session_forked", {
    stage: original.stage, actor: "user",
    data: { forked_from: sessionId },
  });

  return { ok: true, sessionId: fork.id };
}

/**
 * Clone: deep copy - same as fork PLUS claude_session_id for --resume.
 * The new session will resume the same Claude conversation.
 */
export function cloneSession(app: AppContext, sessionId: string, newName?: string): SessionOpResult {
  const original = app.sessions.get(sessionId);
  if (!original) return { ok: false, message: `Session ${sessionId} not found` };

  const baseName = original.summary || sessionId;
  const clone = app.sessions.create({
    ticket: original.ticket || undefined,
    summary: newName ?? `${baseName} (clone)`,
    repo: original.repo || undefined,
    flow: original.flow,
    compute_name: original.compute_name || undefined,
    workdir: original.workdir || undefined,
  });

  app.sessions.update(clone.id, {
    stage: original.stage,
    status: "ready",
    group_name: original.group_name,
    claude_session_id: original.claude_session_id, // --resume handoff
  });

  app.events.log(clone.id, "session_cloned", {
    stage: original.stage, actor: "user",
    data: { cloned_from: sessionId, claude_session_id: original.claude_session_id },
  });

  return { ok: true, sessionId: clone.id };
}

export async function handoff(app: AppContext, sessionId: string, toAgent: string, instructions?: string): Promise<{ ok: boolean; message: string }> {
  const result = cloneSession(app, sessionId, instructions);
  if (!result.ok) return { ok: false, message: (result as { ok: false; message: string }).message };

  app.events.log(result.sessionId, "session_handoff", {
    actor: "user",
    data: { from_session: sessionId, to_agent: toAgent, instructions },
  });

  return await dispatch(app, result.sessionId);
}

// ── Fork/Join ───────────────────────────────────────────────────────────────

export async function fork(app: AppContext, parentId: string, task: string, opts?: {
  agent?: string;
  dispatch?: boolean;
}): SessionOpResult {
  const parent = app.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent not found" };

  const forkGroup = parent.fork_group ?? randomUUID().slice(0, 8);
  if (!parent.fork_group) app.sessions.update(parentId, { fork_group: forkGroup });

  const child = app.sessions.create({
    ticket: parent.ticket || undefined,
    summary: task,
    repo: parent.repo || undefined,
    flow: "bare",
    compute_name: parent.compute_name || undefined,
    workdir: parent.workdir || undefined,
  });

  app.sessions.update(child.id, {
    parent_id: parentId, fork_group: forkGroup,
    stage: parent.stage, status: "ready",
  });
  app.events.log(child.id, "session_forked", {
    stage: parent.stage, actor: "user",
    data: { parent_id: parentId, fork_group: forkGroup, task },
  });

  if (opts?.dispatch !== false) {
    await dispatch(app, child.id);
  }
  return { ok: true, sessionId: child.id };
}

async function dispatchFork(app: AppContext, sessionId: string, stageDef: flow.StageDefinition): Promise<{ ok: boolean; message: string }> {
  // Read PLAN.md or use default subtasks
  const session = app.sessions.get(sessionId)!;
  const subtasks = extractSubtasks(app, session);

  const children: string[] = [];
  for (const sub of subtasks.slice(0, stageDef.max_parallel ?? 4)) {
    const result = await fork(app, sessionId, sub.task, { dispatch: true });
    if (result.ok) children.push(result.sessionId);
  }

  app.sessions.update(sessionId, { status: "running" });
  app.events.log(sessionId, "fork_started", {
    stage: session.stage, actor: "system",
    data: { children_count: children.length, children },
  });

  return { ok: true, message: `Forked into ${children.length} sessions` };
}

async function dispatchFanOut(app: AppContext, sessionId: string, stageDef: flow.StageDefinition): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId)!;
  const subtasks = extractSubtasks(app, session);

  const maxParallel = stageDef.max_parallel ?? 8;
  const result = fanOut(app, sessionId, {
    tasks: subtasks.slice(0, maxParallel).map((s) => ({
      summary: s.task,
      agent: stageDef.agent ?? session.agent ?? "implementer",
    })),
  });

  if (!result.ok) return { ok: false, message: result.message ?? "Fan-out failed" };

  // Dispatch all children -- await so their session_ids are registered before returning
  const dispatched = await Promise.allSettled(
    (result.childIds ?? []).map((childId) => dispatch(app, childId)),
  );

  return { ok: true, message: `Fan-out: ${dispatched.length} children dispatched` };
}

export async function joinFork(app: AppContext, parentId: string, force = false): Promise<{ ok: boolean; message: string }> {
  const children = app.sessions.getChildren(parentId);
  if (!children.length) return { ok: false, message: "No children" };

  const notDone = children.filter((c) => c.status !== "completed");
  if (notDone.length && !force) {
    return { ok: false, message: `${notDone.length} children not done` };
  }

  app.events.log(parentId, "fork_joined", { actor: "user", data: { children: children.length } });
  app.sessions.update(parentId, { status: "ready", fork_group: null });
  return await advance(app, parentId, true);
}

/**
 * Check if a parent session can auto-join after a child completes or fails.
 * Returns true if the parent was advanced (all children are done).
 */
export async function checkAutoJoin(app: AppContext, childSessionId: string): Promise<boolean> {
  const child = app.sessions.get(childSessionId);
  if (!child?.parent_id) return false;

  const parent = app.sessions.get(child.parent_id);
  if (!parent) return false;
  if (parent.status !== "waiting") return false;

  const children = app.sessions.getChildren(parent.id);
  const allDone = children.every((c) => c.status === "completed" || c.status === "failed");
  if (!allDone) return false;

  const failed = children.filter((c) => c.status === "failed");
  if (failed.length > 0) {
    app.events.log(parent.id, "fan_out_partial_failure", {
      actor: "system",
      data: { failed: failed.map((f) => f.id), total: children.length },
    });
  }

  app.events.log(parent.id, "auto_join", {
    actor: "system",
    data: { children: children.length, failed: failed.length },
  });
  app.sessions.update(parent.id, { status: "ready", fork_group: null });
  await advance(app, parent.id, true);
  return true;
}

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * Fully delete a session: kill agent, clean up provider resources, clean
 * hooks, delete DB rows. All provider-specific logic delegated to the provider.
 */
export async function deleteSessionAsync(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
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
    try { claude.removeSettings(session.workdir); } catch (e: any) {
      logError("session", `delete ${sessionId}: removeSettings: ${e?.message ?? e}`);
    }
    try { claude.removeChannelConfig(session.workdir); } catch (e: any) {
      logError("session", `delete ${sessionId}: removeChannelConfig: ${e?.message ?? e}`);
    }
  }

  // 3. Clean up worktree directory (provider-independent fallback --
  // ensures cleanup even when no compute is assigned or provider doesn't handle local worktrees)
  await removeSessionWorktree(app, session);

  // 4. Soft-delete (keeps DB row for 90s undo window)
  app.sessions.softDelete(sessionId);

  app.events.log(sessionId, "session_deleted", { actor: "user" });

  return { ok: true, message: "Session deleted (undo available for 90s)" };
}

export async function undeleteSessionAsync(app: AppContext, sessionId: string): Promise<{ ok: boolean; message: string }> {
  const restored = app.sessions.undelete(sessionId);
  if (!restored) return { ok: false, message: `Session ${sessionId} not found or not deleted` };

  app.events.log(sessionId, "session_undeleted", { actor: "user" });

  return { ok: true, message: `Session restored (status: ${restored.status})` };
}

// ── Provider resolution ──────────────────────────────────────────────────────

/** Safely run a provider method for a session. Resolves provider, handles null, logs errors. */
async function withProvider(
  session: Session,
  label: string,
  fn: (provider: ComputeProvider, compute: Compute) => Promise<void>,
): Promise<boolean> {
  const { provider, compute } = resolveProvider(session);
  if (!provider || !compute) return false;
  return safeAsync(label, () => fn(provider, compute));
}

/** Clean up provider resources when a session reaches a terminal state (completed/failed). */
export async function cleanupOnTerminal(app: AppContext, sessionId: string): Promise<void> {
  const session = app.sessions.get(sessionId);
  if (!session) return;
  await withProvider(session, `cleanup ${sessionId}`, (p, c) => p.cleanupSession(c, session));
}

// ── Internal ────────────────────────────────────────────────────────────────

/** Setup git worktree + Claude trust for the session working directory. */
export async function setupSessionWorktree(
  app: AppContext,
  session: Session,
  compute: Compute | null,
  provider: ComputeProvider | undefined,
  onLog?: (msg: string) => void,
): Promise<string> {
  const log = onLog ?? (() => {});

  // Resolve the repo source path BEFORE deciding whether to worktree.
  // Previously we bailed out when workdir was "." or null -- that's exactly
  // the self-dogfood case (ark running on its own repo with --repo .), and
  // it's the most dangerous case to skip isolation for: without a worktree
  // the agent edits the live checkout and parallel dispatches collide.
  //
  // Prefer session.repo (stable source-of-truth for the upstream checkout);
  // fall back to workdir only when repo isn't set. This matters on resume:
  // a previous dispatch may have already set session.workdir to a worktree
  // path that cleanupSession then deleted -- using workdir as the source
  // would chase a dangling reference.
  const repoRaw = session.repo;
  const workdirRaw = session.workdir;
  const hasExplicitRepo = repoRaw && repoRaw !== "." && repoRaw.trim() !== "";
  const hasExplicitWorkdir = workdirRaw && workdirRaw !== "." && workdirRaw.trim() !== "";
  const repoSource = hasExplicitRepo
    ? resolve(repoRaw!)
    : (hasExplicitWorkdir ? resolve(workdirRaw!) : resolve("."));

  let effectiveWorkdir = repoSource;

  // Create git worktree unless provider doesn't support it or session config explicitly disables it.
  // We worktree when repoSource is a real git repo -- even if it resolves to the current cwd
  // (that is precisely when isolation matters most for the self-dogfood loop).
  const wantWorktree = provider?.supportsWorktree === true && session.config?.worktree !== false;
  if (wantWorktree && existsSync(join(repoSource, ".git"))) {
    log("Setting up git worktree...");
    const wt = await setupWorktree(app, repoSource, session.id, session.branch ?? undefined);
    if (wt) {
      effectiveWorkdir = wt;
    } else {
      // Hard fail: silently falling back to the live checkout is dangerous.
      // Surface the error so the operator knows isolation was not achieved.
      throw new Error(
        `Failed to create git worktree for session ${session.id} from ${repoSource}. ` +
        `Refusing to dispatch against the live checkout. Check git worktree state (\`git worktree list\` in ${repoSource}) and retry.`,
      );
    }
  }

  // Copy untracked files + run setup from .ark.yaml worktree config
  if (effectiveWorkdir !== repoSource) {
    const repoConfig = loadRepoConfig(repoSource);
    if (repoConfig.worktree?.copy?.length) {
      log("Copying untracked files to worktree...");
      const copied = await copyWorktreeFiles(repoSource, effectiveWorkdir, repoConfig.worktree.copy);
      if (copied.length > 0) {
        log(`Copied ${copied.length} file(s): ${copied.slice(0, 5).join(", ")}${copied.length > 5 ? "..." : ""}`);
      }
    }
    if (repoConfig.worktree?.setup) {
      log("Running worktree setup script...");
      await runWorktreeSetup(effectiveWorkdir, repoConfig.worktree.setup, log);
    }
  }

  // Trust worktree for Claude
  log("Configuring Claude trust + channel...");
  claude.trustWorktree(repoSource, effectiveWorkdir);

  // Persist an ABSOLUTE workdir on the session row. The previous behaviour
  // left session.workdir as null/"." when the user passed --repo ".", which
  // tripped the transcript parser into resolving an empty path against the
  // parent process cwd and attributing the wrong jsonl file. Resolving here
  // (against the dispatching process cwd, NOT the agent cwd) gives every
  // downstream observer (parser, status poller, web UI) an unambiguous
  // absolute path. Idempotent: skip the write if the row already matches.
  const persisted = resolve(effectiveWorkdir);
  if (session.workdir !== persisted) {
    app.sessions.update(session.id, { workdir: persisted });
    (session as { workdir: string | null }).workdir = persisted;
  }

  return effectiveWorkdir;
}

/** Apply arc.json container setup: Docker Compose and devcontainer. */
async function applyContainerSetup(
  compute: Compute,
  effectiveWorkdir: string,
  launchContent: string,
  onLog: (msg: string) => void,
): Promise<string> {
  if (!effectiveWorkdir) return launchContent;

  // Docker Compose - only when explicitly enabled in arc.json { "compose": true }
  const arcJson = parseArcJson(effectiveWorkdir);
  if (arcJson?.compose === true && compute.config?.ip) {
    onLog("Starting Docker Compose services...");
    const { sshExec, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
    sshExec(sshKeyPath(compute.name), compute.config.ip as string,
      `cd ${effectiveWorkdir} && docker compose up -d`);
  }

  // Devcontainer - only used when explicitly enabled in arc.json { "devcontainer": true }
  if (arcJson?.devcontainer === true) {
    onLog("Building devcontainer...");
    const { buildLaunchCommand } = await import("../../compute/providers/docker/devcontainer.js");
    return buildLaunchCommand(effectiveWorkdir, launchContent);
  }

  return launchContent;
}

/** Prepare remote compute: connectivity check, env sync, docker/devcontainer setup. */
export async function prepareRemoteEnvironment(app: AppContext, 
  session: Session,
  compute: Compute,
  provider: ComputeProvider,
  effectiveWorkdir: string,
  opts?: { launchContent?: string; onLog?: (msg: string) => void },
): Promise<{ finalLaunchContent: string; ports: any[] }> {
  const log = opts?.onLog ?? (() => {});

  // Auto-start stopped computes
  if (compute.status === "stopped") {
    log(`Starting compute '${compute.name}'...`);
    await provider.start(compute);
  }

  // Verify host is reachable before starting expensive sync/clone chain
  const ip = (compute.config as { ip?: string }).ip;
  if (ip) {
    log("Checking host connectivity...");
    const { sshExecAsync, sshKeyPath } = await import("../../compute/providers/ec2/ssh.js");
    const { exitCode } = await sshExecAsync(sshKeyPath(compute.name), ip, "echo ok", { timeout: 15_000 });
    if (exitCode !== 0) {
      throw new Error(`Cannot reach compute '${compute.name}' at ${ip}`);
    }
  }

  // Resolve ports from arc.json / devcontainer / compose
  const ports = effectiveWorkdir ? resolvePortDecls(effectiveWorkdir) : [];

  // Store ports on session config
  if (ports.length > 0) {
    app.sessions.update(session.id, {
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

  // Apply container setup (Docker Compose + devcontainer)
  const finalLaunchContent = await applyContainerSetup(compute, effectiveWorkdir, opts?.launchContent ?? "", log);

  return { finalLaunchContent, ports };
}

async function _launchAgentTmux(app: AppContext,
  session: Session, stage: string,
  claudeArgs: string[], task: string, agent: agentRegistry.AgentDefinition,
  opts?: { autonomy?: string; onLog?: (msg: string) => void },
): Promise<string> {
  const log = opts?.onLog ?? (() => {});
  const tmuxName = `ark-${session.id}`;

  // Resolve compute + provider
  const compute = session.compute_name ? app.computes.get(session.compute_name) : null;
  const provider = getProvider(compute?.provider ?? "local");

  // Setup worktree + trust
  const effectiveWorkdir = await setupSessionWorktree(app, session, compute, provider, log);

  // Determine conductor URL based on compute type
  const arcJson = effectiveWorkdir ? parseArcJson(effectiveWorkdir) : null;
  const usesDevcontainer = arcJson?.devcontainer ?? false;
  const { DEFAULT_CONDUCTOR_URL, DOCKER_CONDUCTOR_URL } = await import("../constants.js");
  const conductorUrl = usesDevcontainer
    ? DOCKER_CONDUCTOR_URL
    : DEFAULT_CONDUCTOR_URL;

  // Channel config + launcher
  const channelPort = app.sessions.channelPort(session.id);
  const channelConfig = provider?.buildChannelConfig(session.id, stage, channelPort, { conductorUrl });
  const originalRepoDir = session.repo ? resolve(session.repo) : undefined;
  const mcpConfigPath = claude.writeChannelConfig(session.id, stage, channelPort, effectiveWorkdir, { conductorUrl, channelConfig, tracksDir: app.config.tracksDir, originalRepoDir });

  // Status hooks + permissions allow-list -- write .claude/settings.local.json
  claude.writeSettings(session.id, conductorUrl, effectiveWorkdir, {
    autonomy: opts?.autonomy,
    agent: { tools: agent.tools, mcp_servers: agent.mcp_servers },
    tenantId: session.tenant_id ?? "default",
  });

  // Build launch env from agent config + provider-specific env (e.g. auth tokens for remote)
  const launchEnv = { ...(agent.env ?? {}), ...(provider?.buildLaunchEnv(session) ?? {}) };

  const { content: launchContent, claudeSessionId } = claude.buildLauncher({
    workdir: effectiveWorkdir,
    claudeArgs,
    mcpConfigPath,
    prevClaudeSessionId: session.claude_session_id,
    sessionName: session.summary ?? session.id,
    env: launchEnv,
  });

  const launcher = tmux.writeLauncher(session.id, launchContent, app.config.tracksDir);

  // Save task for reference
  const sessionDir = join(app.config.tracksDir, session.id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "task.txt"), task);

  // Remote compute (providers that don't support local worktrees)
  if (compute && provider && !provider.supportsWorktree) {
    const { finalLaunchContent, ports } = await prepareRemoteEnvironment(app,
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

    app.sessions.update(session.id, { claude_session_id: claudeSessionId });

    // Deliver task via channel (tunnels are now up, channel port is accessible locally)
    log("Delivering task...");
    claude.deliverTask(session.id, channelPort, task, stage);

    return result;
  }

  // Local launch via launcher abstraction
  log("Starting local session...");
  const launchResult = await app.launcher.launch(session, `bash ${launcher}`, {
    arkDir: app.config.arkDir,
    workdir: effectiveWorkdir,
  });
  claude.autoAcceptChannelPrompt(launchResult.handle);
  log("Delivering task...");
  claude.deliverTask(session.id, channelPort, task, stage);
  app.sessions.update(session.id, { claude_session_id: claudeSessionId });

  return launchResult.handle;
}

/** Build the task header: agent role, stage description, and reporting instructions. */
function formatTaskHeader(app: AppContext, session: Session, stage: string, agentName: string): string[] {
  const parts: string[] = [];
  const isBare = session.flow === "bare";

  // Get resolved stage with substituted variables
  const vars = buildSessionVars(sessionAsVars(session));
  const resolved = resolveFlow(app, session.flow, vars);
  const stageDef = resolved?.stages.find(s => s.name === stage);

  // Every autonomously-dispatched session (including bare) gets an actionable
  // first-turn prompt. The system prompt gives Claude context, but Claude only
  // starts working when it receives a user message -- this IS that user message.
  // "Wait for instructions via steer" framing is wrong for --dispatch mode.
  if (stageDef?.task) {
    parts.push(stageDef.task);
    parts.push(`\nYou are the ${agentName} agent, running the '${stage}' stage.`);
  } else if (isBare) {
    // Bare flow under autonomous dispatch: treat the summary as an actionable task.
    parts.push(`Begin working on the following task immediately. Do not ask for confirmation.`);
    parts.push(`\nTask: ${session.summary ?? "(no summary provided)"}`);
    parts.push(`\nYou are the ${agentName} agent.`);
  } else {
    parts.push(`Work on ${session.ticket ?? session.id}: ${session.summary ?? "the task"}`);
    parts.push(`\nYou are the ${agentName} agent, running the '${stage}' stage.`);
  }

  // Readiness + completion reporting
  parts.push(`\nWhen you start up, immediately call the \`report\` tool with type='progress' to announce you are online and ready for work.`);
  parts.push(`When you finish your work, call \`report\` with type='completed' and a concise summary of what you accomplished (files changed, tests added, key decisions). This summary is shown to the user in the dashboard.`);

  return parts;
}

/** Append previous stage context: completed stages, PLAN.md, and recent git log. */
async function appendPreviousStageContext(app: AppContext, session: Session): Promise<string[]> {
  const parts: string[] = [];

  // Previous stage context
  const events = app.events.list(session.id);
  const completed = events.filter((e) => e.type === "stage_completed");
  if (completed.length) {
    parts.push("\n## Previous stages:");
    for (const c of completed) {
      const d = c.data ?? {};
      parts.push(`- ${c.stage} (agent=${d.agent ?? "?"}, turns=${d.num_turns ?? "?"}, cost=$${d.cost_usd ?? 0})`);
    }
  }

  // Check for PLAN.md
  const wtDir = join(app.config.worktreesDir, session.id);
  const planPath = join(wtDir, "PLAN.md");
  if (existsSync(planPath)) {
    let plan = readFileSync(planPath, "utf-8");
    if (plan.length > 3000) plan = plan.slice(0, 3000) + "\n... (truncated)";
    parts.push(`\n## PLAN.md:\n${plan}`);
  } else {
    // Fallback: inject completion summary from previous stage as plan context.
    // Covers cases where the planner reported its analysis in the completion
    // summary but failed to write PLAN.md.
    const completionSummary = (session.config as any)?.completion_summary as string | undefined;
    if (completionSummary) {
      parts.push(`\n## Previous stage summary (PLAN.md not found):\n${completionSummary.slice(0, 3000)}`);
    }
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

  return parts;
}

async function buildTaskWithHandoff(app: AppContext, session: Session, stage: string, agentName: string): Promise<string> {
  const header = formatTaskHeader(app, session, stage, agentName);
  const context = await appendPreviousStageContext(app, session);

  // Apply message filter if agent config specifies one
  try {
    const projectRoot = agentRegistry.findProjectRoot(session.workdir || session.repo) ?? undefined;
    const agent = app.agents.get(agentName, projectRoot);
    if (agent) {
      const mFilter = parseMessageFilter(agent);
      if (mFilter) {
        const messages = app.messages.list(session.id).map(m => ({
          role: m.role, content: m.content, timestamp: m.created_at,
        }));
        const filtered = filterMessages(messages, mFilter);
        if (filtered.length > 0) {
          context.push("\n## Filtered conversation context:");
          for (const m of filtered) {
            context.push(`[${m.role}]: ${m.content.slice(0, 500)}`);
          }
        }
      }
    }
  } catch { /* skip message filtering on error */ }

  return [...header, ...context].join("\n");
}

function extractSubtasks(app: AppContext, session: Session): { name: string; task: string }[] {
  const wtDir = join(app.config.worktreesDir, session.id);
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

async function setupWorktree(app: AppContext, repoPath: string, sessionId: string, branch?: string): Promise<string | null> {
  const wtPath = join(app.config.worktreesDir, sessionId);
  if (existsSync(wtPath)) return wtPath;

  const branchName = branch ?? `ark-${sessionId}`;
  try {
    await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    // Try with new branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", branchName, wtPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return wtPath;
    } catch (e: any) {
      if (!String(e).includes("already exists")) {
        logError("session", `setupWorktree: new branch '${branchName}' failed: ${e?.message ?? e}`);
      }
    }
    // Try existing branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", wtPath, branchName], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return wtPath;
    } catch (e: any) {
      if (!String(e).includes("already checked out") && !String(e).includes("already exists")) {
        logError("session", `setupWorktree: existing branch '${branchName}' failed: ${e?.message ?? e}`);
      }
    }
    // Unique branch
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "add", "-b", `ark-${sessionId}`, wtPath], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return wtPath;
    } catch (e: any) {
      logError("session", `setupWorktree: all strategies failed for ${sessionId}: ${e?.message ?? e}`);
    }
  } catch (e: any) {
    logError("session", `setupWorktree: worktree prune failed: ${e?.message ?? e}`);
  }
  return null;
}

/**
 * Copy untracked files matching glob patterns from source repo into worktree.
 * Only copies files that exist in the source but NOT in the worktree (avoids
 * overwriting tracked files that git already placed).
 */
export async function copyWorktreeFiles(
  sourceRepo: string,
  worktreeDir: string,
  patterns: string[],
): Promise<string[]> {
  const copied: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes("..")) continue;

    const glob = new Bun.Glob(pattern);
    for await (const relPath of glob.scan({ cwd: sourceRepo, dot: true })) {
      const target = join(worktreeDir, relPath);
      if (existsSync(target)) continue;

      const source = join(sourceRepo, relPath);
      mkdirSync(dirname(target), { recursive: true });
      const content = readFileSync(source);
      writeFileSync(target, content);
      copied.push(relPath);
    }
  }
  return copied;
}

/**
 * Run a setup script in the worktree directory after file copy.
 * Times out after 60 seconds. Errors are logged but do not fail dispatch.
 */
export async function runWorktreeSetup(
  worktreeDir: string,
  command: string,
  onLog?: (msg: string) => void,
): Promise<void> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd: worktreeDir,
      timeout: 60_000,
      encoding: "utf-8",
    });
    if (stdout?.trim()) onLog?.(`setup stdout: ${stdout.trim().slice(0, 500)}`);
    if (stderr?.trim()) onLog?.(`setup stderr: ${stderr.trim().slice(0, 500)}`);
  } catch (e: any) {
    onLog?.(`Worktree setup script failed (non-fatal): ${e?.message ?? e}`);
  }
}

// ── Worktree diff ───────────────────────────────────────────────────────

/**
 * Get a diff summary for a session's worktree branch vs its base branch.
 * Used for previewing changes before merge or PR creation.
 */
export async function worktreeDiff(app: AppContext, sessionId: string, opts?: {
  base?: string;
}): Promise<{
  ok: boolean;
  stat: string;
  diff: string;
  branch: string;
  baseBranch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  modifiedSinceReview: string[];
  message?: string;
}> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, stat: "", diff: "", branch: "", baseBranch: "", filesChanged: 0, insertions: 0, deletions: 0, modifiedSinceReview: [], message: "Session not found" };

  const workdir = session.workdir;
  const repo = session.repo;
  if (!workdir || !repo) return { ok: false, stat: "", diff: "", branch: "", baseBranch: "", filesChanged: 0, insertions: 0, deletions: 0, modifiedSinceReview: [], message: "No workdir or repo" };

  // Determine the worktree path and branch
  const wtDir = join(app.config.worktreesDir, sessionId);
  let branch = session.branch;
  if (!branch && existsSync(wtDir)) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      branch = stdout.trim();
    } catch { /* ignore */ }
  }
  if (!branch) return { ok: false, stat: "", diff: "", branch: "", baseBranch: "", filesChanged: 0, insertions: 0, deletions: 0, modifiedSinceReview: [], message: "Cannot determine branch" };

  const baseBranch = opts?.base ?? DEFAULT_BASE_BRANCH;

  try {
    // Get diff stat
    const { stdout: stat } = await execFileAsync("git", ["-C", repo, "diff", "--stat", `${baseBranch}...${branch}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

    // Get full diff (truncated to 50KB)
    const { stdout: fullDiff } = await execFileAsync("git", ["-C", repo, "diff", `${baseBranch}...${branch}`], { encoding: "utf-8", maxBuffer: 1024 * 1024 });
    const diff = fullDiff.length > 50_000 ? fullDiff.slice(0, 50_000) + "\n... (truncated)" : fullDiff;

    // Parse shortstat for counts
    const { stdout: shortstat } = await execFileAsync("git", ["-C", repo, "diff", "--shortstat", `${baseBranch}...${branch}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    // "3 files changed, 42 insertions(+), 7 deletions(-)"
    const filesMatch = shortstat.match(/(\d+) files? changed/);
    const insMatch = shortstat.match(/(\d+) insertions?/);
    const delMatch = shortstat.match(/(\d+) deletions?/);

    // Track file hashes for re-review detection
    const modifiedSinceReview: string[] = [];
    try {
      const { stdout: diffNames } = await execFileAsync("git", ["-C", repo, "diff", "--name-only", `${baseBranch}...${branch}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      const files = diffNames.trim().split("\n").filter(Boolean);
      const fileHashes: Record<string, string> = {};
      for (const file of files) {
        try {
          const { stdout: hash } = await execFileAsync("git", ["-C", repo, "rev-parse", `${branch}:${file}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
          fileHashes[file] = hash.trim();
        } catch { /* file may have been deleted */ }
      }

      // Compare against previously reviewed hashes
      const prevReviewed = app.sessions.get(sessionId)?.config?.reviewed_files as Record<string, string> | undefined;
      if (prevReviewed) {
        for (const file of files) {
          if (prevReviewed[file] && prevReviewed[file] !== fileHashes[file]) {
            modifiedSinceReview.push(file);
          }
        }
      }

      // Save current hashes as reviewed
      app.sessions.mergeConfig(sessionId, { reviewed_files: fileHashes });
    } catch { /* re-review tracking is best-effort */ }

    return {
      ok: true,
      stat,
      diff,
      branch,
      baseBranch,
      filesChanged: filesMatch ? parseInt(filesMatch[1]) : 0,
      insertions: insMatch ? parseInt(insMatch[1]) : 0,
      deletions: delMatch ? parseInt(delMatch[1]) : 0,
      modifiedSinceReview,
    };
  } catch (e: any) {
    return { ok: false, stat: "", diff: "", branch, baseBranch, filesChanged: 0, insertions: 0, deletions: 0, modifiedSinceReview: [], message: e?.message ?? "Diff failed" };
  }
}

// ── Auto-rebase before PR ───────────────────────────────────────────────

/**
 * Rebase the session branch onto the base branch before PR creation.
 * Fetches origin, then rebases onto origin/<base>. On conflict, aborts
 * the rebase and returns an error -- the branch is left unchanged.
 */
export async function rebaseOntoBase(app: AppContext, sessionId: string, opts?: {
  base?: string;
}): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  const wtDir = join(app.config.worktreesDir, sessionId);
  const gitDir = existsSync(wtDir) ? wtDir : repo;
  const base = opts?.base ?? DEFAULT_BASE_BRANCH;

  try {
    // Fetch latest from origin so rebase target is up to date
    await execFileAsync("git", ["-C", gitDir, "fetch", "origin", base], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Rebase onto origin/<base>
    await execFileAsync("git", ["-C", gitDir, "rebase", `origin/${base}`], {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    app.events.log(sessionId, "rebase_completed", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { base },
    });

    return { ok: true, message: `Rebased onto origin/${base}` };
  } catch (e: any) {
    // Abort the rebase to leave the branch in its original state
    try {
      await execFileAsync("git", ["-C", gitDir, "rebase", "--abort"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { /* already clean */ }

    logWarn("session", `rebaseOntoBase: rebase failed for ${sessionId}: ${e?.message ?? e}`);
    return { ok: false, message: `Rebase failed: ${e?.message ?? e}` };
  }
}

// ── Worktree PR creation ────────────────────────────────────────────────

/**
 * Create a GitHub PR from a session's worktree branch.
 * Optionally rebases onto the base branch first (controlled by repo config auto_rebase, default true).
 * Pushes the branch and creates the PR via gh CLI.
 */
export async function createWorktreePR(app: AppContext, sessionId: string, opts?: {
  title?: string;
  body?: string;
  base?: string;
  draft?: boolean;
}): Promise<{ ok: boolean; message: string; pr_url?: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  // Determine branch
  const wtDir = join(app.config.worktreesDir, sessionId);
  let branch = session.branch;
  if (!branch && existsSync(wtDir)) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      branch = stdout.trim();
    } catch { /* ignore */ }
  }
  if (!branch) return { ok: false, message: "Cannot determine worktree branch" };

  const base = opts?.base ?? DEFAULT_BASE_BRANCH;
  const title = opts?.title ?? session.summary ?? `ark: ${sessionId}`;
  const body = opts?.body ?? `Session: ${sessionId}\nFlow: ${session.flow}\nAgent: ${session.agent ?? "default"}`;

  // Auto-rebase onto base branch (unless disabled in repo config)
  const repoConfig = session.workdir ? loadRepoConfig(session.workdir) : {};
  if (repoConfig.auto_rebase !== false) {
    const rebaseResult = await rebaseOntoBase(app, sessionId, { base });
    if (!rebaseResult.ok) {
      // Rebase failed (conflict) -- still proceed with PR creation without rebase.
      // The PR will show merge conflicts on GitHub, which is preferable to blocking.
      logWarn("session", `createWorktreePR: auto-rebase failed for ${sessionId}, proceeding without rebase: ${rebaseResult.message}`);
    }
  }

  try {
    // 1. Push branch
    const pushDir = existsSync(wtDir) ? wtDir : repo;
    await execFileAsync("git", ["-C", pushDir, "push", "-u", "origin", branch], { encoding: "utf-8", timeout: 30_000 });

    // 2. Create PR via gh CLI
    const ghArgs = ["pr", "create", "--repo", repo, "--head", branch, "--base", base, "--title", title, "--body", body];
    if (opts?.draft) ghArgs.push("--draft");
    const { stdout } = await execFileAsync("gh", ghArgs, { encoding: "utf-8", timeout: 30_000, cwd: pushDir });
    const prUrl = stdout.trim();

    // 3. Store PR URL on session
    app.sessions.update(sessionId, { pr_url: prUrl });
    app.events.log(sessionId, "pr_created", {
      stage: session.stage ?? undefined,
      actor: "user",
      data: { pr_url: prUrl, branch, base, draft: opts?.draft ?? false },
    });

    return { ok: true, message: `PR created: ${prUrl}`, pr_url: prUrl };
  } catch (e: any) {
    return { ok: false, message: `PR creation failed: ${e?.message ?? e}` };
  }
}

// ── PR merge (auto_merge action) ────────────────────────────────────────

/**
 * Merge an existing PR via `gh pr merge`. Used by the auto_merge action stage.
 * Requires the session to have a pr_url (set by a preceding create_pr stage).
 */
export async function mergeWorktreePR(app: AppContext, sessionId: string, opts?: {
  method?: "merge" | "squash" | "rebase";
  deleteAfter?: boolean;
}): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const prUrl = session.pr_url;
  if (!prUrl) return { ok: false, message: "Session has no PR URL -- run create_pr first" };

  const repo = session.repo;
  if (!repo) return { ok: false, message: "Session has no repo" };

  const method = opts?.method ?? "squash";
  const deleteAfter = opts?.deleteAfter ?? true;

  try {
    const ghArgs = ["pr", "merge", prUrl, `--${method}`, "--auto"];
    if (deleteAfter) ghArgs.push("--delete-branch");
    const cwd = session.workdir ?? repo;
    await execFileAsync("gh", ghArgs, { encoding: "utf-8", timeout: 30_000, cwd });

    app.events.log(sessionId, "pr_merged", {
      stage: session.stage ?? undefined,
      actor: "system",
      data: { pr_url: prUrl, method, delete_branch: deleteAfter },
    });

    return { ok: true, message: `PR merge initiated: ${prUrl}` };
  } catch (e: any) {
    return { ok: false, message: `PR merge failed: ${e?.message ?? e}` };
  }
}

// ── Worktree finish ─────────────────────────────────────────────────────

/**
 * Finish a worktree session: merge branch into target, remove worktree, delete session.
 * Aborts safely on merge conflict without losing work.
 */
export async function finishWorktree(app: AppContext, sessionId: string, opts?: {
  into?: string;  // target branch (default: "main")
  noMerge?: boolean;  // skip merge, just cleanup
  keepBranch?: boolean;  // don't delete the branch after merge
  createPR?: boolean;  // create a PR instead of merging locally
  force?: boolean;  // skip verification
}): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const workdir = session.workdir;
  const repo = session.repo;
  if (!workdir || !repo) return { ok: false, message: "Session has no workdir or repo. Create a new session with --repo to enable worktree features." };

  // Verify before finishing (unless force)
  if (!opts?.force) {
    const verify = await runVerification(app, sessionId);
    if (!verify.ok) {
      return { ok: false, message: `Cannot finish: verification failed:\n${verify.message}` };
    }
  }

  // Determine the worktree path and branch
  const wtDir = join(app.config.worktreesDir, sessionId);
  const isWorktree = existsSync(wtDir);

  // Get the branch name from the worktree
  let branch: string | null = session.branch;
  if (!branch && isWorktree) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", wtDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      branch = stdout.trim();
    } catch { /* ignore */ }
  }

  if (!branch) return { ok: false, message: "Cannot determine worktree branch" };

  const targetBranch = opts?.into ?? DEFAULT_BASE_BRANCH;

  // 1. Stop the session if running
  if (!["completed", "failed", "stopped", "pending"].includes(session.status)) {
    await stop(app, sessionId);
  }

  // 1b. Create PR instead of merging locally if requested
  if (opts?.createPR) {
    const prResult = await createWorktreePR(app, sessionId, { base: targetBranch, title: session.summary ?? undefined });
    if (!prResult.ok) return prResult;
    // Still cleanup worktree after PR creation
    if (isWorktree) {
      try {
        await execFileAsync("git", ["-C", repo, "worktree", "remove", wtDir, "--force"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      } catch (e: any) {
        logError("session", `finishWorktree: remove worktree failed: ${e?.message ?? e}`);
      }
    }
    await deleteSessionAsync(app, sessionId);
    app.events.log(sessionId, "worktree_finished", { actor: "user", data: { branch, targetBranch, merged: false, pr: true } });
    return { ok: true, message: `PR created and worktree cleaned up. ${prResult.pr_url ?? ""}`.trim() };
  }

  // 2. Merge branch into target (unless --no-merge)
  if (!opts?.noMerge) {
    try {
      // Checkout target branch in the main repo
      await execFileAsync("git", ["-C", repo, "checkout", targetBranch], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      // Merge the worktree branch
      await execFileAsync("git", ["-C", repo, "merge", branch, "--no-edit"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // Abort merge on conflict to preserve state
      try { await execFileAsync("git", ["-C", repo, "merge", "--abort"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }); } catch { /* ignore */ }
      return { ok: false, message: `Merge conflict: ${branch} into ${targetBranch}. Resolve manually. Worktree preserved.` };
    }
  }

  // 3. Remove worktree
  if (isWorktree) {
    try {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", wtDir, "--force"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      logError("session", `finishWorktree: remove worktree failed: ${e?.message ?? e}`);
    }
  }

  // 4. Delete branch (unless --keep-branch)
  if (!opts?.keepBranch && branch !== targetBranch) {
    try {
      await execFileAsync("git", ["-C", repo, "branch", "-d", branch], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // Branch may not exist or not be fully merged -- try force delete
      try { await execFileAsync("git", ["-C", repo, "branch", "-D", branch], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }); } catch { /* ignore */ }
    }
  }

  // 5. Delete the session
  await deleteSessionAsync(app, sessionId);

  const mergeMsg = opts?.noMerge ? "skipped merge" : `merged ${branch} → ${targetBranch}`;
  app.events.log(sessionId, "worktree_finished", { actor: "user", data: { branch, targetBranch, merged: !opts?.noMerge } });

  return { ok: true, message: `Finished: ${mergeMsg}, worktree removed, session deleted` };
}

// ── Wait ────────────────────────────────────────────────────────────────

/** Wait for a session to reach a terminal state. Returns the final session. */
export async function waitForCompletion(app: AppContext, 
  sessionId: string,
  opts?: { timeoutMs?: number; pollMs?: number; onStatus?: (status: string) => void },
): Promise<{ session: Session | null; timedOut: boolean }> {
  const timeout = opts?.timeoutMs ?? 0; // 0 = no timeout
  const pollMs = opts?.pollMs ?? 3000;
  const start = Date.now();

  while (true) {
    const session = app.sessions.get(sessionId);
    if (!session) return { session: null, timedOut: false };

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

export async function getOutput(app: AppContext, sessionId: string, opts?: { lines?: number; ansi?: boolean }): Promise<string> {
  const session = app.sessions.get(sessionId);
  if (!session?.session_id) return "";

  const { provider, compute } = resolveProvider(session);
  if (provider && compute) {
    return provider.captureOutput(compute, session, opts);
  }
  return "";
}

export async function send(app: AppContext, sessionId: string, message: string): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session?.session_id) return { ok: false, message: "No active session" };

  // Check for prompt injection in user messages
  try {
    const injection = detectInjection(message);
    if (injection.severity === "high") {
      app.events.log(sessionId, "prompt_injection_blocked", { actor: "system", data: { patterns: injection.patterns } });
      return { ok: false, message: "Message blocked: potential prompt injection detected" };
    }
    if (injection.detected) {
      app.events.log(sessionId, "prompt_injection_warning", { actor: "system", data: { patterns: injection.patterns, severity: injection.severity } });
    }
  } catch { /* skip prompt guard on error */ }

  const { sendReliable } = await import("../send-reliable.js");
  const result = await sendReliable(session.session_id, message, { waitForReady: false, maxRetries: 3 });
  return { ok: result.ok, message: result.message };
}

// ── Re-exports from session-hooks.ts (hook status, reports, stage handoff) ──
export {
  applyHookStatus,
  applyReport,
  mediateStageHandoff,
  parseOnFailure,
  retryWithContext,
  detectStatus,
} from "./session-hooks.js";
export type {
  HookStatusResult,
  ReportResult,
  StageHandoffResult,
} from "./session-hooks.js";

// ── Sub-Agent Fan-Out ──────────────────────────────────────────────────────

interface FanOutTask {
  summary: string;
  agent?: string;
  flow?: string;
}

export function fanOut(app: AppContext, 
  parentId: string,
  opts: { tasks: FanOutTask[] }
): { ok: boolean; childIds?: string[]; message?: string } {
  const parent = app.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent session not found" };
  if (opts.tasks.length === 0) return { ok: false, message: "No tasks provided" };

  const forkGroup = randomUUID().slice(0, 8);
  const childIds: string[] = [];

  for (const task of opts.tasks) {
    const child = app.sessions.create({
      summary: task.summary,
      repo: parent.repo || undefined,
      flow: task.flow ?? "bare",
      compute_name: parent.compute_name || undefined,
      workdir: parent.workdir || undefined,
      group_name: parent.group_name || undefined,
    });
    // Set first stage so child is dispatchable
    const childFlow = task.flow ?? "bare";
    const firstStage = flow.getFirstStage(app,childFlow);
    app.sessions.update(child.id, {
      parent_id: parentId,
      fork_group: forkGroup,
      agent: task.agent ?? null,
      stage: firstStage ?? null,
      status: "ready",
    });
    childIds.push(child.id);
  }

  // Parent waits for children
  app.sessions.update(parentId, { status: "waiting", fork_group: forkGroup });
  app.events.log(parentId, "fan_out", {
    actor: "system",
    data: { childCount: childIds.length, forkGroup },
  });

  return { ok: true, childIds };
}

// ── Subagents ────────────────────────────────────────────────────────────────

/**
 * Spawn a subagent -- an independent child session with its own model/agent.
 * Unlike fork (which copies the parent's config), subagents can use different
 * models and agents for cost optimization or specialization.
 */
export function spawnSubagent(app: AppContext, parentId: string, opts: {
  task: string;
  agent?: string;       // override agent (default: parent's agent)
  model?: string;       // override model (e.g., "haiku" for cheap tasks)
  group_name?: string;
  extensions?: string[]; // MCP extensions to enable
}): { ok: boolean; sessionId?: string; message: string } {
  const parent = app.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent session not found" };

  const session = app.sessions.create({
    summary: opts.task,
    repo: parent.repo || undefined,
    flow: "quick",  // subagents use single-stage flow
    compute_name: parent.compute_name || undefined,
    workdir: parent.workdir || undefined,
    group_name: opts.group_name ?? parent.group_name ?? undefined,
    config: {
      parent_id: parentId,
      subagent: true,
      model_override: opts.model,
      extensions: opts.extensions,
    },
  });

  const agentName = opts.agent ?? parent.agent;
  app.sessions.update(session.id, { agent: agentName, parent_id: parentId });

  // Set first stage so the subagent is dispatchable
  const firstStage = flow.getFirstStage(app,"quick");
  if (firstStage) {
    app.sessions.update(session.id, { stage: firstStage, status: "ready" });
  }

  app.events.log(session.id, "subagent_spawned", {
    actor: "system",
    data: { parent_id: parentId, task: opts.task, agent: agentName, model: opts.model },
  });

  return { ok: true, sessionId: session.id, message: `Subagent ${session.id} spawned` };
}

/**
 * Spawn multiple subagents in parallel and optionally wait for all to complete.
 */
export async function spawnParallelSubagents(app: AppContext, parentId: string, tasks: Array<{
  task: string;
  agent?: string;
  model?: string;
}>): Promise<{ ok: boolean; sessionIds: string[]; message: string }> {
  const ids: string[] = [];
  for (const t of tasks) {
    const result = spawnSubagent(app, parentId, t);
    if (result.ok && result.sessionId) {
      ids.push(result.sessionId);
    }
  }

  // Dispatch all in parallel
  await Promise.allSettled(ids.map(id => dispatch(app, id).catch(() => {})));

  return { ok: true, sessionIds: ids, message: `${ids.length} subagents spawned and dispatched` };
}

// ── Worktree cleanup ──────────────────────────────────────────────────────

/**
 * Remove the worktree directory for a session, if it exists.
 * Provider-independent -- called from stop() and deleteSessionAsync() so
 * worktrees are always cleaned up regardless of compute provider availability.
 */
export async function removeSessionWorktree(app: AppContext, session: Session): Promise<void> {
  const wtPath = join(app.config.worktreesDir, session.id);
  if (!existsSync(wtPath)) return;

  // Try git worktree remove first (cleans up .git/worktrees metadata)
  const repo = session.repo ?? session.workdir;
  if (repo) {
    try {
      await execFileAsync("git", ["-C", repo, "worktree", "remove", "--force", wtPath], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return;
    } catch { /* fall through to rmSync */ }
  }

  // Fallback: direct removal (no repo context or git worktree remove failed)
  await safeAsync(`removeSessionWorktree: rmSync ${session.id}`, async () => {
    rmSync(wtPath, { recursive: true, force: true });
  });
}

/** Find orphaned worktrees -- worktree dirs with no matching session. */
export function findOrphanedWorktrees(app: AppContext): string[] {
  const wtDir = app.config.worktreesDir;
  if (!existsSync(wtDir)) return [];

  const sessionIds = new Set(app.sessions.list({ limit: 1000 }).map(s => s.id));
  const orphans: string[] = [];

  try {
    for (const entry of readdirSync(wtDir)) {
      if (!sessionIds.has(entry)) {
        orphans.push(entry);
      }
    }
  } catch { /* ignore */ }

  return orphans;
}

/** Remove orphaned worktrees. Returns count of removed. */
export async function cleanupWorktrees(app: AppContext): Promise<{ removed: number; errors: string[] }> {
  const orphans = findOrphanedWorktrees(app);
  let removed = 0;
  const errors: string[] = [];

  for (const id of orphans) {
    const wtPath = join(app.config.worktreesDir, id);
    try {
      // Try git worktree remove first
      await execFileAsync("git", ["worktree", "remove", wtPath, "--force"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      removed++;
    } catch {
      // Fallback: just remove the directory
      try {
        rmSync(wtPath, { recursive: true, force: true });
        removed++;
      } catch (e: any) {
        errors.push(`${id}: ${e.message}`);
      }
    }
  }

  return { removed, errors };
}
