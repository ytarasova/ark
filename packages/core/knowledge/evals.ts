/**
 * Runtime agent evaluation -- tracks real performance from completed sessions.
 * Stores results as knowledge graph nodes for querying and drift detection.
 */

import type { AppContext } from "../app.js";
import type { Session } from "../../types/index.js";

export interface AgentEvalResult {
  agentRole: string;
  runtime: string;
  model: string;
  sessionId: string;
  metrics: {
    completed: boolean;           // did the session reach "completed" status?
    testsPassed: boolean | null;  // did verify scripts pass? null if no verify
    prCreated: boolean;           // was a PR created?
    turnCount: number;            // total conversation turns
    durationMs: number;           // wall clock time
    tokenCost: number;            // USD cost
    filesChanged: number;         // files modified
    retryCount: number;           // how many retries before success
  };
  timestamp: string;
}

/**
 * Evaluate a completed session and store results in the knowledge graph.
 * Called automatically when a session completes.
 */
export function evaluateSession(app: AppContext, session: Session): AgentEvalResult {
  const events = app.events.list(session.id);

  // Count turns (stage_started events approximate turns)
  const turnCount = events.filter(e => e.type === "agent_progress" || e.type === "stage_started").length;

  // Check if tests passed (look for verification events)
  const verifyEvents = events.filter(e => e.type === "verification_result");
  const testsPassed = verifyEvents.length > 0
    ? verifyEvents.every(e => (e.data as any)?.result === "PASS")
    : null;

  // Check PR creation
  const prCreated = !!session.pr_url;

  // Count retries
  const retryCount = events.filter(e => e.type === "retry_with_context").length;

  // Duration
  const created = new Date(session.created_at).getTime();
  const updated = new Date(session.updated_at).getTime();
  const durationMs = updated - created;

  // Cost (from session config if available)
  const tokenCost = (session.config as any)?.usage?.totalCost ?? 0;

  // Files changed
  const filesChanged = ((session.config as any)?.filesChanged as string[])?.length ?? 0;

  const result: AgentEvalResult = {
    agentRole: session.agent ?? "unknown",
    runtime: (session.config as any)?.runtime_override ?? "claude",
    model: (session.config as any)?.model ?? "unknown",
    sessionId: session.id,
    metrics: {
      completed: session.status === "completed",
      testsPassed,
      prCreated,
      turnCount,
      durationMs,
      tokenCost,
      filesChanged,
      retryCount,
    },
    timestamp: new Date().toISOString(),
  };

  // Store as knowledge node
  app.knowledge.addNode({
    id: `eval:${session.id}`,
    type: "session", // evals are metadata on sessions
    label: `Eval: ${session.summary ?? session.id}`,
    content: JSON.stringify(result.metrics),
    metadata: {
      eval: true,
      agentRole: result.agentRole,
      runtime: result.runtime,
      model: result.model,
      ...result.metrics,
    },
  });

  // Link to session node if it exists
  const sessionNode = app.knowledge.getNode(`session:${session.id}`);
  if (sessionNode) {
    app.knowledge.addEdge(`eval:${session.id}`, `session:${session.id}`, "relates_to");
  }

  return result;
}

/**
 * Get aggregate stats for an agent role.
 */
export function getAgentStats(app: AppContext, agentRole: string): {
  totalSessions: number;
  completionRate: number;
  avgDurationMs: number;
  avgCost: number;
  avgTurns: number;
  testPassRate: number;
  prRate: number;
} {
  const evalNodes = app.knowledge.listNodes({ type: "session" })
    .filter(n => (n.metadata as any).eval && (n.metadata as any).agentRole === agentRole);

  if (evalNodes.length === 0) {
    return { totalSessions: 0, completionRate: 0, avgDurationMs: 0, avgCost: 0, avgTurns: 0, testPassRate: 0, prRate: 0 };
  }

  const completed = evalNodes.filter(n => (n.metadata as any).completed).length;
  const withTests = evalNodes.filter(n => (n.metadata as any).testsPassed !== null);
  const testsPassed = withTests.filter(n => (n.metadata as any).testsPassed).length;
  const withPR = evalNodes.filter(n => (n.metadata as any).prCreated).length;
  const totalDuration = evalNodes.reduce((s, n) => s + ((n.metadata as any).durationMs ?? 0), 0);
  const totalCost = evalNodes.reduce((s, n) => s + ((n.metadata as any).tokenCost ?? 0), 0);
  const totalTurns = evalNodes.reduce((s, n) => s + ((n.metadata as any).turnCount ?? 0), 0);

  return {
    totalSessions: evalNodes.length,
    completionRate: completed / evalNodes.length,
    avgDurationMs: totalDuration / evalNodes.length,
    avgCost: totalCost / evalNodes.length,
    avgTurns: totalTurns / evalNodes.length,
    testPassRate: withTests.length > 0 ? testsPassed / withTests.length : 0,
    prRate: withPR / evalNodes.length,
  };
}

/**
 * Detect drift: compare recent performance to baseline.
 * Returns positive if improving, negative if degrading.
 */
export function detectDrift(app: AppContext, agentRole: string, recentDays: number = 7, baselineDays: number = 28): {
  completionRateDelta: number;
  avgCostDelta: number;
  avgTurnsDelta: number;
  alert: boolean;
} {
  const allEvals = app.knowledge.listNodes({ type: "session" })
    .filter(n => (n.metadata as any).eval && (n.metadata as any).agentRole === agentRole);

  const now = Date.now();
  const recentCutoff = now - recentDays * 86400000;
  const baselineCutoff = now - baselineDays * 86400000;

  const recent = allEvals.filter(n => new Date(n.created_at).getTime() >= recentCutoff);
  const baseline = allEvals.filter(n => {
    const t = new Date(n.created_at).getTime();
    return t >= baselineCutoff && t < recentCutoff;
  });

  if (recent.length < 3 || baseline.length < 3) {
    return { completionRateDelta: 0, avgCostDelta: 0, avgTurnsDelta: 0, alert: false };
  }

  const recentCompletion = recent.filter(n => (n.metadata as any).completed).length / recent.length;
  const baselineCompletion = baseline.filter(n => (n.metadata as any).completed).length / baseline.length;

  const recentCost = recent.reduce((s, n) => s + ((n.metadata as any).tokenCost ?? 0), 0) / recent.length;
  const baselineCost = baseline.reduce((s, n) => s + ((n.metadata as any).tokenCost ?? 0), 0) / baseline.length;

  const recentTurns = recent.reduce((s, n) => s + ((n.metadata as any).turnCount ?? 0), 0) / recent.length;
  const baselineTurns = baseline.reduce((s, n) => s + ((n.metadata as any).turnCount ?? 0), 0) / baseline.length;

  const completionDelta = recentCompletion - baselineCompletion;
  const costDelta = baselineCost > 0 ? (recentCost - baselineCost) / baselineCost : 0;
  const turnsDelta = baselineTurns > 0 ? (recentTurns - baselineTurns) / baselineTurns : 0;

  // Alert if completion rate dropped >10% or cost increased >20%
  const alert = completionDelta < -0.10 || costDelta > 0.20;

  return {
    completionRateDelta: completionDelta,
    avgCostDelta: costDelta,
    avgTurnsDelta: turnsDelta,
    alert,
  };
}

/**
 * List eval nodes, optionally filtered by agent role.
 */
export function listEvals(app: AppContext, agentRole?: string, limit: number = 20): AgentEvalResult[] {
  let evalNodes = app.knowledge.listNodes({ type: "session", limit: limit * 2 })
    .filter(n => (n.metadata as any).eval);

  if (agentRole) {
    evalNodes = evalNodes.filter(n => (n.metadata as any).agentRole === agentRole);
  }

  return evalNodes.slice(0, limit).map(n => {
    const meta = n.metadata as any;
    const metrics = n.content ? JSON.parse(n.content) : {};
    return {
      agentRole: meta.agentRole ?? "unknown",
      runtime: meta.runtime ?? "claude",
      model: meta.model ?? "unknown",
      sessionId: n.id.replace("eval:", ""),
      metrics: {
        completed: meta.completed ?? false,
        testsPassed: meta.testsPassed ?? null,
        prCreated: meta.prCreated ?? false,
        turnCount: meta.turnCount ?? metrics.turnCount ?? 0,
        durationMs: meta.durationMs ?? metrics.durationMs ?? 0,
        tokenCost: meta.tokenCost ?? metrics.tokenCost ?? 0,
        filesChanged: meta.filesChanged ?? metrics.filesChanged ?? 0,
        retryCount: meta.retryCount ?? metrics.retryCount ?? 0,
      },
      timestamp: n.created_at,
    };
  });
}
