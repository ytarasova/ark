/**
 * Stage advancement -- advance, complete, handoff, and non-claude transcript parsing.
 *
 * Extracted from stage-orchestrator.ts. Handles linear + graph flow routing,
 * stage isolation, verification, and session completion bookkeeping.
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";
import * as flow from "../state/flow.js";
import { saveCheckpoint } from "../session/checkpoint.js";
import { parseGraphFlow, getSuccessors, resolveNextStages, computeSkippedStages } from "../state/graph-flow.js";
import { logDebug, logError } from "../observability/structured-log.js";
import { recordEvent } from "../observability.js";
import { emitSessionSpanEnd, emitStageSpanStart, emitStageSpanEnd, flushSpans } from "../observability/otlp.js";
import { loadRepoConfig } from "../repo-config.js";

import { recordSessionUsage, runVerification, cloneSession } from "./session-lifecycle.js";
import { capturePlanMdIfPresent } from "./plan-artifact.js";

export async function advance(
  app: AppContext,
  sessionId: string,
  force = false,
  outcome?: string,
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  const { flow: flowName, stage } = session;
  if (!stage) return { ok: false, message: "No current stage. The session may have completed its flow." };

  if (!force) {
    const { canProceed, reason } = flow.evaluateGate(app, flowName, stage, session);
    if (!canProceed) return { ok: false, message: reason };
  }

  // Snapshot PLAN.md from the worktree into BlobStore before we advance off
  // this stage. Downstream stages (including ones on a different replica)
  // read the locator from `session.config.plan_md_locator` instead of
  // expecting the file to still be on whatever local disk wrote it.
  await capturePlanMdIfPresent(app, session);

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
      const flowState = await app.flowStates.load(sessionId);
      const completedStages = flowState?.completedStages ?? [];
      const skippedStages = flowState?.skippedStages ?? [];

      // Resolve next stages with conditional routing and join barrier awareness
      const readyStages = resolveNextStages(graphFlow, stage, session.config ?? {}, completedStages, skippedStages);

      if (readyStages.length > 0) {
        // Mark current stage completed
        try {
          await app.flowStates.markStageCompleted(sessionId, stage);
        } catch {
          logDebug("session", "flow-state persistence is best-effort -- stage still advances");
        }

        // Compute which stages should be skipped due to conditional branching
        const allSuccessors = getSuccessors(graphFlow, stage);
        if (allSuccessors.length > 1) {
          const newSkipped = computeSkippedStages(graphFlow, stage, readyStages, skippedStages);
          if (newSkipped.length > skippedStages.length) {
            try {
              await app.flowStates.markStagesSkipped(sessionId, newSkipped);
            } catch {
              logDebug("session", "flow-state persistence is best-effort -- stage still advances");
            }
          }
        }

        // Advance to the first ready stage (additional ready stages will be
        // picked up on subsequent advance() calls if the flow has parallel branches)
        const graphNextStage = readyStages[0];
        try {
          await app.flowStates.setCurrentStage(sessionId, graphNextStage, flowName);
        } catch {
          logDebug("session", "flow-state persistence is best-effort -- stage still advances");
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
        await app.sessions.update(sessionId, graphSessionUpdates);
        await app.events.log(sessionId, "stage_ready", {
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
          await app.flowStates.markStageCompleted(sessionId, stage);
        } catch {
          logDebug("session", "flow-state persistence is best-effort -- stage still advances");
        }
        await app.sessions.update(sessionId, { status: "waiting" });
        await app.events.log(sessionId, "stage_waiting", {
          actor: "system",
          stage,
          data: { via: "graph-flow-conditional", waiting_for: allSuccessors, reason: "join-barrier" },
        });
        return { ok: true, message: `Stage ${stage} completed, waiting for join barrier` };
      }

      // Terminal node -- flow complete
      try {
        await app.flowStates.markStageCompleted(sessionId, stage);
      } catch {
        logDebug("session", "flow-state persistence is best-effort -- stage still advances");
      }
      await app.sessions.update(sessionId, { status: "completed" });
      await app.events.log(sessionId, "session_completed", {
        stage,
        actor: "system",
        data: { final_stage: stage, flow: flowName, via: "graph-flow-conditional" },
      });
      await app.messages.markRead(sessionId);
      emitStageSpanEnd(sessionId, { status: "completed" });
      const s = await app.sessions.get(sessionId);
      const agg = await app.usageRecorder.getSessionCost(sessionId);
      emitSessionSpanEnd(sessionId, {
        status: "completed",
        tokens_in: agg.input_tokens,
        tokens_out: agg.output_tokens,
        tokens_cache: agg.cache_read_tokens,
        cost_usd: agg.cost,
        turns: s?.config?.turns as number | undefined,
      });
      // GC template-lifecycle compute now that the session is done.
      try {
        const { garbageCollectComputeIfTemplate } = await import("./compute-lifecycle.js");
        await garbageCollectComputeIfTemplate(app, s?.compute_name);
      } catch {
        logDebug("session", "compute gc on complete -- best-effort");
      }
      flushSpans();
      return { ok: true, message: "Flow completed (graph-flow)" };
    }
  } catch {
    logDebug("session", "graph flow not applicable, fall through to linear");
  }

  const nextStage = flow.resolveNextStage(app, flowName, stage, outcome);
  if (!nextStage) {
    // Flow complete -- persist final stage completion
    try {
      await app.flowStates.markStageCompleted(sessionId, stage, outcome ? { outcome } : undefined);
    } catch {
      logDebug("session", "flow-state persistence is best-effort -- stage still advances");
    }
    await app.sessions.update(sessionId, { status: "completed" });
    await app.events.log(sessionId, "session_completed", {
      stage,
      actor: "system",
      data: { final_stage: stage, flow: flowName },
    });
    // Auto-clear unread badge so completed sessions don't show stale notifications
    await app.messages.markRead(sessionId);

    emitStageSpanEnd(sessionId, { status: "completed" });
    const s = await app.sessions.get(sessionId);
    const agg = await app.usageRecorder.getSessionCost(sessionId);
    emitSessionSpanEnd(sessionId, {
      status: "completed",
      tokens_in: agg.input_tokens,
      tokens_out: agg.output_tokens,
      tokens_cache: agg.cache_read_tokens,
      cost_usd: agg.cost,
      turns: s?.config?.turns as number | undefined,
    });
    // GC template-lifecycle compute now that the session is done.
    try {
      const { garbageCollectComputeIfTemplate } = await import("./compute-lifecycle.js");
      await garbageCollectComputeIfTemplate(app, s?.compute_name);
    } catch {
      logDebug("session", "compute gc on complete -- best-effort");
    }
    flushSpans();

    // Extract skills from completed session transcript
    try {
      const { extractAndSaveSkills } = await import("../agent/skill-extractor.js");
      const { getSessionConversation } = await import("../search/search.js");
      const conv = await getSessionConversation(app, sessionId);
      if (conv.length > 0) {
        const turns = conv.map((c) => ({ role: c.role === "message" ? "user" : "assistant", content: c.content }));
        extractAndSaveSkills(sessionId, turns, app);
      }
    } catch {
      logDebug("session", "skill extraction is best-effort");
    }

    return { ok: true, message: "Flow completed" };
  }

  // Persist flow state: mark completed + set next
  try {
    await app.flowStates.markStageCompleted(sessionId, stage, outcome ? { outcome } : undefined);
  } catch {
    logDebug("session", "flow-state persistence is best-effort -- stage still advances");
  }
  try {
    await app.flowStates.setCurrentStage(sessionId, nextStage, flowName);
  } catch {
    logDebug("session", "flow-state persistence is best-effort -- stage still advances");
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
  await app.sessions.update(sessionId, sessionUpdates);

  await app.events.log(sessionId, "stage_ready", {
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

export async function complete(
  app: AppContext,
  sessionId: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; message: string }> {
  const session = await app.sessions.get(sessionId);
  if (!session) return { ok: false, message: `Session ${sessionId} not found` };

  // Run verification unless --force.
  // Quick sync check: only call async runVerification if there are todos or verify scripts.
  if (!opts?.force) {
    const hasTodos = (await app.todos.list(sessionId)).length > 0;
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

  await app.events.log(sessionId, "stage_completed", {
    stage: session.stage,
    actor: "user",
    data: { note: "Manually completed" },
  });
  await app.messages.markRead(sessionId);

  // Parse agent transcript for token usage (non-Claude agents).
  // Claude usage is captured via hooks in applyHookStatus(); this handles codex/gemini.
  parseNonClaudeTranscript(app, session);

  await app.sessions.update(sessionId, { status: "ready", session_id: null });
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
  const result = await cloneSession(app, sessionId, instructions);
  if (!result.ok) return { ok: false, message: (result as { ok: false; message: string }).message };

  await app.events.log(result.sessionId, "session_handoff", {
    actor: "user",
    data: { from_session: sessionId, to_agent: toAgent, instructions },
  });

  // Dynamic import avoids a cycle with dispatch.ts.
  const { dispatch } = await import("./dispatch.js");
  return await dispatch(app, result.sessionId);
}
