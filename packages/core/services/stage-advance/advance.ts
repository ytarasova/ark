/**
 * StageAdvancer -- runs `advance()`: linear + graph-flow routing, stage
 * isolation, flow completion bookkeeping, optional idempotency.
 *
 * Extracted from the legacy `services/stage-advance.ts` free function.
 * Deps-only; no AppContext, no getApp().
 */

import type { Session } from "../../../types/index.js";
import { parseGraphFlow, getSuccessors, resolveNextStages, computeSkippedStages } from "../../state/graph-flow.js";
import { logDebug } from "../../observability/structured-log.js";
import { recordEvent } from "../../observability.js";
import { emitSessionSpanEnd, emitStageSpanStart, emitStageSpanEnd, flushSpans } from "../../observability/otlp.js";
import { withIdempotency } from "../idempotency.js";
import type { IdempotencyCapable, StageAdvanceDeps, StageOpResult } from "./types.js";

export class StageAdvancer {
  constructor(private readonly deps: StageAdvanceDeps) {}

  /** Public entry -- advance a session to its next stage, wrapped in idempotency. */
  advance(sessionId: string, force = false, outcome?: string, opts?: IdempotencyCapable): Promise<StageOpResult> {
    return withIdempotency(
      this.deps.db,
      { sessionId, stage: null, opKind: "advance", idempotencyKey: opts?.idempotencyKey },
      () => this.advanceImpl(sessionId, force, outcome),
    );
  }

  /** Internal advance -- no idempotency wrapper. Called by complete()'s cascade. */
  async advanceImpl(sessionId: string, force: boolean, outcome: string | undefined): Promise<StageOpResult> {
    const { deps } = this;
    const session = await deps.sessions.get(sessionId);
    if (!session) return { ok: false, message: `Session ${sessionId} not found` };

    const { flow: flowName, stage } = session;
    if (!stage) return { ok: false, message: "No current stage. The session may have completed its flow." };

    if (!force) {
      const { canProceed, reason } = deps.evaluateGate(flowName, stage, session);
      if (!canProceed) return { ok: false, message: reason };
    }

    // Snapshot PLAN.md into BlobStore before we advance off this stage.
    await deps.capturePlanMd(session);

    // Checkpoint before advancing.
    await deps.saveCheckpoint(sessionId);

    // Observability: track stage advancement.
    recordEvent({ type: "agent_turn", sessionId, data: { stage } });

    // Graph flow routing: if the flow defines edges or depends_on, use DAG conditional routing.
    try {
      const flowDef = deps.flows.get(flowName);
      const hasDependsOn = flowDef?.stages?.some((s) => s.depends_on?.length > 0);
      if (flowDef && (flowDef.edges?.length > 0 || hasDependsOn)) {
        const graphResult = await this.advanceGraph(session, flowName, stage, force);
        if (graphResult) return graphResult;
      }
    } catch {
      logDebug("session", "graph flow not applicable, fall through to linear");
    }

    return this.advanceLinear(session, flowName, stage, force, outcome);
  }

  // ── Graph-flow path ──────────────────────────────────────────────────────

  private async advanceGraph(
    session: Session,
    flowName: string,
    stage: string,
    force: boolean,
  ): Promise<StageOpResult | null> {
    const { deps } = this;
    const sessionId = session.id;
    const flowDef = deps.flows.get(flowName);
    if (!flowDef) return null;

    const graphFlow = parseGraphFlow(flowDef);
    const flowState = await deps.flowStates.load(sessionId);
    const completedStages = flowState?.completedStages ?? [];
    const skippedStages = flowState?.skippedStages ?? [];

    const readyStages = resolveNextStages(graphFlow, stage, session.config, completedStages, skippedStages);

    if (readyStages.length > 0) {
      // Mark current stage completed (best-effort).
      try {
        await deps.flowStates.markStageCompleted(sessionId, stage);
      } catch {
        logDebug("session", "flow-state persistence is best-effort -- stage still advances");
      }

      // Compute which stages should be skipped due to conditional branching.
      const allSuccessors = getSuccessors(graphFlow, stage);
      if (allSuccessors.length > 1) {
        const newSkipped = computeSkippedStages(graphFlow, stage, readyStages, skippedStages);
        if (newSkipped.length > skippedStages.length) {
          try {
            await deps.flowStates.markStagesSkipped(sessionId, newSkipped);
          } catch {
            logDebug("session", "flow-state persistence is best-effort -- stage still advances");
          }
        }
      }

      const graphNextStage = readyStages[0];
      try {
        await deps.flowStates.setCurrentStage(sessionId, graphNextStage, flowName);
      } catch {
        logDebug("session", "flow-state persistence is best-effort -- stage still advances");
      }

      // Stage isolation: clear runtime handles so next stage gets a fresh runtime.
      const graphNextStageDef = deps.getStage(flowName, graphNextStage);
      const graphIsolation = graphNextStageDef?.isolation ?? "fresh";
      const graphNextAction = deps.getStageAction(flowName, graphNextStage);
      const graphSessionUpdates: Partial<Session> = { stage: graphNextStage, status: "ready", session_id: null };
      if (graphNextAction.agent) {
        // session.agent is `string | null` -- when the next stage's agent
        // is an inline definition (object), persist the placeholder
        // "inline" so SQLite doesn't reject the bind. The actual agent
        // spec lives on session.config.inline_flow.stages[i].agent.
        graphSessionUpdates.agent = typeof graphNextAction.agent === "string" ? graphNextAction.agent : "inline";
      }
      if (graphIsolation === "fresh") {
        graphSessionUpdates.claude_session_id = null;
      }
      await deps.sessions.update(sessionId, graphSessionUpdates);
      await deps.events.log(sessionId, "stage_ready", {
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
      const graphStageDef = deps.getStage(flowName, graphNextStage);
      emitStageSpanStart(sessionId, {
        stage: graphNextStage,
        agent: graphNextAction?.agent,
        gate: graphStageDef?.gate,
      });
      await deps.saveCheckpoint(sessionId);
      return { ok: true, message: `Advanced to ${graphNextStage} (graph-flow)` };
    }

    // No ready stages -- either a join barrier or a terminal node.
    const allSuccessors = getSuccessors(graphFlow, stage, session.config);
    if (allSuccessors.length > 0) {
      try {
        await deps.flowStates.markStageCompleted(sessionId, stage);
      } catch {
        logDebug("session", "flow-state persistence is best-effort -- stage still advances");
      }
      await deps.sessions.update(sessionId, { status: "waiting" });
      await deps.events.log(sessionId, "stage_waiting", {
        actor: "system",
        stage,
        data: { via: "graph-flow-conditional", waiting_for: allSuccessors, reason: "join-barrier" },
      });
      return { ok: true, message: `Stage ${stage} completed, waiting for join barrier` };
    }

    // Terminal node -- flow complete.
    try {
      await deps.flowStates.markStageCompleted(sessionId, stage);
    } catch {
      logDebug("session", "flow-state persistence is best-effort -- stage still advances");
    }
    await this.markFlowCompleted(sessionId, stage, flowName, "graph-flow-conditional");
    return { ok: true, message: "Flow completed (graph-flow)" };
  }

  // ── Linear path ──────────────────────────────────────────────────────────

  private async advanceLinear(
    session: Session,
    flowName: string,
    stage: string,
    force: boolean,
    outcome: string | undefined,
  ): Promise<StageOpResult> {
    const { deps } = this;
    const sessionId = session.id;

    const nextStage = deps.resolveNextStage(flowName, stage, outcome);
    if (!nextStage) {
      // Flow complete -- persist final stage completion and tear down.
      try {
        await deps.flowStates.markStageCompleted(sessionId, stage, outcome ? { outcome } : undefined);
      } catch {
        logDebug("session", "flow-state persistence is best-effort -- stage still advances");
      }
      await this.markFlowCompleted(sessionId, stage, flowName, undefined);

      // Extract skills from completed session transcript (best-effort).
      try {
        await deps.extractAndSaveSkills(sessionId);
      } catch {
        logDebug("session", "skill extraction is best-effort");
      }

      return { ok: true, message: "Flow completed" };
    }

    // Persist flow state: mark completed + set next.
    try {
      await deps.flowStates.markStageCompleted(sessionId, stage, outcome ? { outcome } : undefined);
    } catch {
      logDebug("session", "flow-state persistence is best-effort -- stage still advances");
    }
    try {
      await deps.flowStates.setCurrentStage(sessionId, nextStage, flowName);
    } catch {
      logDebug("session", "flow-state persistence is best-effort -- stage still advances");
    }

    const nextAction = deps.getStageAction(flowName, nextStage);
    const nextStageDef = deps.getStage(flowName, nextStage);
    const isolation = nextStageDef?.isolation ?? "fresh";
    const sessionUpdates: Partial<Session> = { stage: nextStage, status: "ready", error: null, session_id: null };
    if (nextAction.agent) {
      // Same coercion as the graph-flow path above -- inline agent
      // definitions are objects; the agent column is string-only.
      sessionUpdates.agent = typeof nextAction.agent === "string" ? nextAction.agent : "inline";
    }
    if (isolation === "fresh") {
      sessionUpdates.claude_session_id = null;
    }
    await deps.sessions.update(sessionId, sessionUpdates);

    await deps.events.log(sessionId, "stage_ready", {
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

    await deps.saveCheckpoint(sessionId);

    return { ok: true, message: `Advanced to ${nextStage}` };
  }

  // ── Flow completion bookkeeping ───────────────────────────────────────────

  private async markFlowCompleted(
    sessionId: string,
    stage: string,
    flowName: string,
    via: string | undefined,
  ): Promise<void> {
    const { deps } = this;
    await deps.sessions.update(sessionId, { status: "completed" });
    await deps.events.log(sessionId, "session_completed", {
      stage,
      actor: "system",
      data: { final_stage: stage, flow: flowName, ...(via ? { via } : {}) },
    });
    await deps.messages.markRead(sessionId);
    emitStageSpanEnd(sessionId, { status: "completed" });
    const s = await deps.sessions.get(sessionId);
    const agg = await deps.usageRecorder.getSessionCost(sessionId);
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
      await deps.gcComputeIfTemplate(s?.compute_name);
    } catch {
      logDebug("session", "compute gc on complete -- best-effort");
    }
    flushSpans();
  }
}
