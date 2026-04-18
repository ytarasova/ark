/**
 * Stage orchestration -- dispatch, advance, fan-out, fork/join, subagents, action execution.
 *
 * Extracted from session-orchestration.ts. All functions take app: AppContext as first arg.
 */

import { randomUUID } from "crypto";
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
import { parseGraphFlow, getSuccessors, resolveNextStages, computeSkippedStages } from "../state/graph-flow.js";
import { markStageCompleted, setCurrentStage, markStagesSkipped, loadFlowState } from "../state/flow-state.js";
import { logError } from "../observability/structured-log.js";
import { recordEvent } from "../observability.js";
import { track } from "../observability/telemetry.js";
import { emitSessionSpanEnd, emitStageSpanStart, emitStageSpanEnd, flushSpans } from "../observability/otlp.js";
import { detectInjection } from "../session/prompt-guard.js";
import { generateRepoMap, formatRepoMap } from "../repo-map.js";
import { getExecutor } from "../executor.js";
import { loadRepoConfig } from "../repo-config.js";

import { sessionAsVars, buildTaskWithHandoff, extractSubtasks } from "./task-builder.js";
import { recordSessionUsage, runVerification, cloneSession } from "./session-lifecycle.js";
import { createWorktreePR, mergeWorktreePR, finishWorktree } from "./workspace-service.js";

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
      id: `symbol:${node.file}::${node.name}:${node.line}`,
      type: "symbol",
      label: node.name,
      metadata: {
        kind: node.kind,
        file: node.file,
        line_start: node.line,
        line_end: node.end_line,
        exported: node.exported === 1,
      },
    });
  }
  for (const edge of data.edges ?? []) {
    const srcNode = (data.nodes ?? []).find((n: any) => n.id === edge.source_id);
    const tgtNode = (data.nodes ?? []).find((n: any) => n.id === edge.target_id);
    if (srcNode && tgtNode) {
      app.knowledge.addEdge(
        `symbol:${srcNode.file}::${srcNode.name}:${srcNode.line}`,
        `symbol:${tgtNode.file}::${tgtNode.name}:${tgtNode.line}`,
        edge.kind === "imports" ? "imports" : "depends_on",
      );
    }
  }
  log(`Remote index: ${addedFiles.size} files, ${(data.nodes ?? []).length} symbols`);
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
        actor: "system",
        data: { url: remoteUrl, dir: tmpDir },
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
    /* skip guard on error */
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
          const data = (await resp.json()) as { ok?: boolean; files?: number; symbols?: number; error?: string };
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
    } catch {
      /* knowledge not available -- continue without context */
    }
  }

  // Inject repo map into agent context for codebase awareness
  if (session.repo) {
    try {
      const repoMap = generateRepoMap(session.workdir ?? session.repo, { maxFiles: 200 });
      if (repoMap.entries.length > 0) {
        const mapStr = formatRepoMap(repoMap.entries, 1500);
        task = task + `\n\n## Repository Structure\n\`\`\`\n${mapStr}\n\`\`\`\n`;
      }
    } catch {
      /* skip repo map on error */
    }
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
      /* no git -- skip */
    }
  }

  app.sessions.update(sessionId, { status: "running", agent: agentName, session_id: tmuxName });
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
    setCurrentStage(app, sessionId, session.stage!, session.flow);
  } catch {
    /* skip flow-state on error */
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
    /* status poller is best-effort -- agent runs fine without it */
  }

  // Observability + telemetry
  recordEvent({ type: "session_start", sessionId, data: { agent: session.agent ?? agentName, flow: session.flow } });
  track("session_dispatched", { agent: agentName });

  return { ok: true, message: tmuxName };
}

export async function advance(
  app: AppContext,
  sessionId: string,
  force = false,
  outcome?: string,
): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const { flow: flowName, stage } = session;
  if (!stage) return { ok: false, message: "No current stage. The session may have completed its flow." };

  if (!force) {
    const { canProceed, reason } = flow.evaluateGate(app, flowName, stage, session);
    if (!canProceed) return { ok: false, message: reason };
  }

  // Checkpoint before advancing to next stage
  saveCheckpoint(app, sessionId);

  // Observability: track stage advancement
  recordEvent({ type: "agent_turn", sessionId, data: { stage } });

  // Graph flow routing: if flow definition has edges, use DAG conditional routing
  try {
    const flowDef = app.flows.get(flowName);
    const hasDependsOn = flowDef?.stages?.some((s) => s.depends_on?.length > 0);
    if (flowDef && (flowDef.edges?.length > 0 || hasDependsOn)) {
      const graphFlow = parseGraphFlow(flowDef);
      const flowState = loadFlowState(app, sessionId);
      const completedStages = flowState?.completedStages ?? [];
      const skippedStages = flowState?.skippedStages ?? [];

      // Resolve next stages with conditional routing and join barrier awareness
      const readyStages = resolveNextStages(graphFlow, stage, session.config ?? {}, completedStages, skippedStages);

      if (readyStages.length > 0) {
        // Mark current stage completed
        try {
          markStageCompleted(app, sessionId, stage);
        } catch {
          /* flow-state persistence is best-effort -- stage still advances */
        }

        // Compute which stages should be skipped due to conditional branching
        const allSuccessors = getSuccessors(graphFlow, stage);
        if (allSuccessors.length > 1) {
          const newSkipped = computeSkippedStages(graphFlow, stage, readyStages, skippedStages);
          if (newSkipped.length > skippedStages.length) {
            try {
              markStagesSkipped(app, sessionId, newSkipped);
            } catch {
              /* flow-state persistence is best-effort -- stage still advances */
            }
          }
        }

        // Advance to the first ready stage (additional ready stages will be
        // picked up on subsequent advance() calls if the flow has parallel branches)
        const graphNextStage = readyStages[0];
        try {
          setCurrentStage(app, sessionId, graphNextStage, flowName);
        } catch {
          /* flow-state persistence is best-effort -- stage still advances */
        }

        // Stage isolation: clear runtime handles so next stage gets a fresh runtime.
        // If the next stage has isolation="continue", preserve claude_session_id for --resume.
        const graphNextStageDef = flow.getStage(app, flowName, graphNextStage);
        const graphIsolation = graphNextStageDef?.isolation ?? "fresh";
        const graphNextAction = flow.getStageAction(app, flowName, graphNextStage);
        const graphSessionUpdates: Partial<Session> = { stage: graphNextStage, status: "ready", session_id: null };
        // Update agent to reflect the next stage's agent (keeps display accurate).
        // For action stages (no agent), preserve the last dispatched agent.
        if (graphNextAction.agent) {
          graphSessionUpdates.agent = graphNextAction.agent;
        }
        if (graphIsolation === "fresh") {
          graphSessionUpdates.claude_session_id = null;
        }
        app.sessions.update(sessionId, graphSessionUpdates);
        app.events.log(sessionId, "stage_ready", {
          actor: "system",
          stage: graphNextStage,
          data: {
            from_stage: stage,
            to_stage: graphNextStage,
            stage_type: graphNextAction.type,
            stage_agent: graphNextAction.agent,
            forced: force,
            isolation: graphIsolation,
            via: "graph-flow-conditional",
            readyStages,
            skippedStages: flowState?.skippedStages ?? [],
          },
        });
        emitStageSpanEnd(sessionId, { status: "completed" });
        const graphStageDef = flow.getStage(app, flowName, graphNextStage);
        emitStageSpanStart(sessionId, {
          stage: graphNextStage,
          agent: graphNextAction?.agent,
          gate: graphStageDef?.gate,
        });
        saveCheckpoint(app, sessionId);
        return { ok: true, message: `Advanced to ${graphNextStage} (graph-flow)` };
      }

      // No ready stages -- check if this is because join barriers aren't met
      // or because we've reached a terminal node
      const allSuccessors = getSuccessors(graphFlow, stage, session.config ?? {});
      if (allSuccessors.length > 0) {
        // Successors exist but aren't ready (join barriers) -- mark completed and wait
        try {
          markStageCompleted(app, sessionId, stage);
        } catch {
          /* flow-state persistence is best-effort -- stage still advances */
        }
        app.sessions.update(sessionId, { status: "waiting" });
        app.events.log(sessionId, "stage_waiting", {
          actor: "system",
          stage,
          data: { via: "graph-flow-conditional", waiting_for: allSuccessors, reason: "join-barrier" },
        });
        return { ok: true, message: `Stage ${stage} completed, waiting for join barrier` };
      }

      // Terminal node -- flow complete
      try {
        markStageCompleted(app, sessionId, stage);
      } catch {
        /* flow-state persistence is best-effort -- stage still advances */
      }
      app.sessions.update(sessionId, { status: "completed" });
      app.events.log(sessionId, "session_completed", {
        stage,
        actor: "system",
        data: { final_stage: stage, flow: flowName, via: "graph-flow-conditional" },
      });
      app.messages.markRead(sessionId);
      emitStageSpanEnd(sessionId, { status: "completed" });
      const s = app.sessions.get(sessionId);
      const agg = app.usageRecorder.getSessionCost(sessionId);
      emitSessionSpanEnd(sessionId, {
        status: "completed",
        tokens_in: agg.input_tokens,
        tokens_out: agg.output_tokens,
        tokens_cache: agg.cache_read_tokens,
        cost_usd: agg.cost,
        turns: s?.config?.turns as number | undefined,
      });
      flushSpans();
      return { ok: true, message: "Flow completed (graph-flow)" };
    }
  } catch {
    /* graph flow not applicable, fall through to linear */
  }

  const nextStage = flow.resolveNextStage(app, flowName, stage, outcome);
  if (!nextStage) {
    // Flow complete -- persist final stage completion
    try {
      markStageCompleted(app, sessionId, stage, outcome ? { outcome } : undefined);
    } catch {
      /* flow-state persistence is best-effort -- stage still advances */
    }
    app.sessions.update(sessionId, { status: "completed" });
    app.events.log(sessionId, "session_completed", {
      stage,
      actor: "system",
      data: { final_stage: stage, flow: flowName },
    });
    // Auto-clear unread badge so completed sessions don't show stale notifications
    app.messages.markRead(sessionId);

    emitStageSpanEnd(sessionId, { status: "completed" });
    const s = app.sessions.get(sessionId);
    const agg = app.usageRecorder.getSessionCost(sessionId);
    emitSessionSpanEnd(sessionId, {
      status: "completed",
      tokens_in: agg.input_tokens,
      tokens_out: agg.output_tokens,
      tokens_cache: agg.cache_read_tokens,
      cost_usd: agg.cost,
      turns: s?.config?.turns as number | undefined,
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
    } catch {
      /* skill extraction is best-effort */
    }

    return { ok: true, message: "Flow completed" };
  }

  // Persist flow state: mark completed + set next
  try {
    markStageCompleted(app, sessionId, stage, outcome ? { outcome } : undefined);
  } catch {
    /* flow-state persistence is best-effort -- stage still advances */
  }
  try {
    setCurrentStage(app, sessionId, nextStage, flowName);
  } catch {
    /* flow-state persistence is best-effort -- stage still advances */
  }

  const nextAction = flow.getStageAction(app, flowName, nextStage);

  // Stage isolation: clear runtime handles so next stage gets a fresh runtime.
  // Default is "fresh" -- each stage starts with a clean slate.
  // If the next stage has isolation="continue", preserve claude_session_id for --resume.
  const nextStageDef = flow.getStage(app, flowName, nextStage);
  const isolation = nextStageDef?.isolation ?? "fresh";
  const sessionUpdates: Partial<Session> = { stage: nextStage, status: "ready", error: null, session_id: null };
  // Update agent to reflect the next stage's agent (keeps display accurate).
  // For action stages (no agent), preserve the last dispatched agent.
  if (nextAction.agent) {
    sessionUpdates.agent = nextAction.agent;
  }
  if (isolation === "fresh") {
    sessionUpdates.claude_session_id = null;
  }
  app.sessions.update(sessionId, sessionUpdates);

  app.events.log(sessionId, "stage_ready", {
    stage: nextStage,
    actor: "system",
    data: {
      from_stage: stage,
      to_stage: nextStage,
      stage_type: nextAction.type,
      stage_agent: nextAction.agent,
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

/**
 * Execute an action stage (create_pr, merge, close, etc.).
 * Called by the conductor when auto-advancing into an action stage.
 */
export async function executeAction(
  app: AppContext,
  sessionId: string,
  action: string,
): Promise<{ ok: boolean; message: string }> {
  const s = app.sessions.get(sessionId);
  if (!s) return { ok: false, message: "Session not found" };

  switch (action) {
    case "create_pr": {
      // Skip if we already know about a PR
      if (s.pr_url) {
        app.events.log(sessionId, "action_executed", {
          stage: s.stage ?? undefined,
          actor: "system",
          data: { action, pr_url: s.pr_url, skipped: "pr_already_exists" },
        });
        return { ok: true, message: `Action '${action}' executed (PR already exists)` };
      }
      // Also check if a PR exists on the branch (agent may have created one without reporting pr_url)
      if (s.branch && s.workdir) {
        try {
          const { stdout: prUrl } = await execFileAsync("gh", ["pr", "view", s.branch, "--json", "url", "-q", ".url"], {
            cwd: s.workdir,
            encoding: "utf-8",
            timeout: 10_000,
          });
          if (prUrl?.trim()) {
            const url = prUrl.trim();
            app.sessions.update(sessionId, { pr_url: url });
            app.events.log(sessionId, "action_executed", {
              stage: s.stage ?? undefined,
              actor: "system",
              data: { action, pr_url: url, skipped: "pr_found_on_branch" },
            });
            return { ok: true, message: `Action '${action}' executed (PR found on branch)` };
          }
        } catch {
          /* no PR exists for this branch -- proceed to create */
        }
      }
      const result = await createWorktreePR(app, sessionId, { title: s.summary ?? undefined });
      if (result.ok) {
        app.events.log(sessionId, "action_executed", {
          stage: s.stage ?? undefined,
          actor: "system",
          data: { action, pr_url: result.pr_url },
        });
        return { ok: true, message: `Action '${action}' executed` };
      }
      return result;
    }
    case "merge_pr":
    case "merge": {
      const result = await finishWorktree(app, sessionId, { force: true });
      if (result.ok) {
        app.events.log(sessionId, "action_executed", {
          stage: s.stage ?? undefined,
          actor: "system",
          data: { action },
        });
      }
      return result;
    }
    case "auto_merge": {
      const result = await mergeWorktreePR(app, sessionId);
      if (result.ok) {
        app.events.log(sessionId, "action_executed", {
          stage: s.stage ?? undefined,
          actor: "system",
          data: { action, pr_url: s.pr_url ?? undefined },
        });
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
      return { ok: true, message: `Action '${action}' executed` };
    }
    default: {
      app.events.log(sessionId, "action_skipped", {
        stage: s.stage ?? undefined,
        actor: "system",
        data: { action, reason: "unknown action type" },
      });
      return { ok: true, message: `Action '${action}' skipped (unknown)` };
    }
  }
}

export async function complete(
  app: AppContext,
  sessionId: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; message: string }> {
  const session = app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // Run verification unless --force.
  // Quick sync check: only call async runVerification if there are todos or verify scripts.
  if (!opts?.force) {
    const hasTodos = app.todos.list(sessionId).length > 0;
    const stageVerify =
      session.stage && session.flow ? flow.getStage(app, session.flow, session.stage)?.verify : undefined;
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
    stage: session.stage,
    actor: "user",
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
    logError("session", "non-Claude transcript parsing failed", {
      sessionId: session.id,
      error: String(e?.message ?? e),
    });
  }
}

export async function handoff(
  app: AppContext,
  sessionId: string,
  toAgent: string,
  instructions?: string,
): Promise<{ ok: boolean; message: string }> {
  const result = cloneSession(app, sessionId, instructions);
  if (!result.ok) return { ok: false, message: (result as { ok: false; message: string }).message };

  app.events.log(result.sessionId, "session_handoff", {
    actor: "user",
    data: { from_session: sessionId, to_agent: toAgent, instructions },
  });

  return await dispatch(app, result.sessionId);
}

// ── Fork/Join ───────────────────────────────────────────────────────────────

export async function fork(
  app: AppContext,
  parentId: string,
  task: string,
  opts?: {
    agent?: string;
    dispatch?: boolean;
  },
): SessionOpResult {
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
    parent_id: parentId,
    fork_group: forkGroup,
    stage: parent.stage,
    status: "ready",
  });
  app.events.log(child.id, "session_forked", {
    stage: parent.stage,
    actor: "user",
    data: { parent_id: parentId, fork_group: forkGroup, task },
  });

  if (opts?.dispatch !== false) {
    await dispatch(app, child.id);
  }
  return { ok: true, sessionId: child.id };
}

async function dispatchFork(
  app: AppContext,
  sessionId: string,
  stageDef: flow.StageDefinition,
): Promise<{ ok: boolean; message: string }> {
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
  const dispatched = await Promise.allSettled((result.childIds ?? []).map((childId) => dispatch(app, childId)));

  return { ok: true, message: `Fan-out: ${dispatched.length} children dispatched` };
}

export async function joinFork(
  app: AppContext,
  parentId: string,
  force = false,
): Promise<{ ok: boolean; message: string }> {
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

// ── Sub-Agent Fan-Out ──────────────────────────────────────────────────────

interface FanOutTask {
  summary: string;
  agent?: string;
  flow?: string;
}

export function fanOut(
  app: AppContext,
  parentId: string,
  opts: { tasks: FanOutTask[] },
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
    const firstStage = flow.getFirstStage(app, childFlow);
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
export function spawnSubagent(
  app: AppContext,
  parentId: string,
  opts: {
    task: string;
    agent?: string;
    model?: string;
    group_name?: string;
    extensions?: string[];
  },
): { ok: boolean; sessionId?: string; message: string } {
  const parent = app.sessions.get(parentId);
  if (!parent) return { ok: false, message: "Parent session not found" };

  const session = app.sessions.create({
    summary: opts.task,
    repo: parent.repo || undefined,
    flow: "quick",
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
  const firstStage = flow.getFirstStage(app, "quick");
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
export async function spawnParallelSubagents(
  app: AppContext,
  parentId: string,
  tasks: Array<{
    task: string;
    agent?: string;
    model?: string;
  }>,
): Promise<{ ok: boolean; sessionIds: string[]; message: string }> {
  const ids: string[] = [];
  for (const t of tasks) {
    const result = spawnSubagent(app, parentId, t);
    if (result.ok && result.sessionId) {
      ids.push(result.sessionId);
    }
  }

  // Dispatch all in parallel
  await Promise.allSettled(ids.map((id) => dispatch(app, id).catch(() => {})));

  return { ok: true, sessionIds: ids, message: `${ids.length} subagents spawned and dispatched` };
}
