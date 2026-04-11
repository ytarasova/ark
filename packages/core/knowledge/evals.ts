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

/** Shape of the metadata we attach to an `eval:<sessionId>` knowledge node. */
interface EvalNodeMetadata {
  eval: boolean;
  agentRole: string;
  runtime: string;
  model: string;
  completed: boolean;
  testsPassed: boolean | null;
  prCreated: boolean;
  turnCount: number;
  durationMs: number;
  tokenCost: number;
  filesChanged: number;
  retryCount: number;
}

/** Narrow an untyped knowledge node metadata record into our EvalNodeMetadata shape. */
function asEvalMeta(metadata: Record<string, unknown> | undefined): EvalNodeMetadata {
  const m = metadata ?? {};
  return {
    eval: Boolean(m.eval),
    agentRole: typeof m.agentRole === "string" ? m.agentRole : "unknown",
    runtime: typeof m.runtime === "string" ? m.runtime : "claude",
    model: typeof m.model === "string" ? m.model : "unknown",
    completed: Boolean(m.completed),
    testsPassed: m.testsPassed === null ? null : Boolean(m.testsPassed),
    prCreated: Boolean(m.prCreated),
    turnCount: typeof m.turnCount === "number" ? m.turnCount : 0,
    durationMs: typeof m.durationMs === "number" ? m.durationMs : 0,
    tokenCost: typeof m.tokenCost === "number" ? m.tokenCost : 0,
    filesChanged: typeof m.filesChanged === "number" ? m.filesChanged : 0,
    retryCount: typeof m.retryCount === "number" ? m.retryCount : 0,
  };
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
    ? verifyEvents.every(e => {
        const data = e.data as Record<string, unknown> | undefined;
        return data?.result === "PASS";
      })
    : null;

  const prCreated = !!session.pr_url;
  const retryCount = events.filter(e => e.type === "retry_with_context").length;

  const created = new Date(session.created_at).getTime();
  const updated = new Date(session.updated_at).getTime();
  const durationMs = updated - created;

  const tokenCost = app.usageRecorder.getSessionCost(session.id).cost;

  const config = (session.config ?? {}) as Record<string, unknown>;
  const filesChanged = Array.isArray(config.filesChanged) ? config.filesChanged.length : 0;
  const runtime = typeof config.runtime_override === "string" ? config.runtime_override : "claude";
  const model = typeof config.model === "string" ? config.model : "unknown";

  const result: AgentEvalResult = {
    agentRole: session.agent ?? "unknown",
    runtime,
    model,
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

  app.knowledge.addNode({
    id: `eval:${session.id}`,
    type: "session",
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
    .map(n => ({ node: n, meta: asEvalMeta(n.metadata) }))
    .filter(({ meta }) => meta.eval && meta.agentRole === agentRole);

  if (evalNodes.length === 0) {
    return { totalSessions: 0, completionRate: 0, avgDurationMs: 0, avgCost: 0, avgTurns: 0, testPassRate: 0, prRate: 0 };
  }

  const completed = evalNodes.filter(({ meta }) => meta.completed).length;
  const withTests = evalNodes.filter(({ meta }) => meta.testsPassed !== null);
  const testsPassed = withTests.filter(({ meta }) => meta.testsPassed).length;
  const withPR = evalNodes.filter(({ meta }) => meta.prCreated).length;
  const totalDuration = evalNodes.reduce((s, { meta }) => s + meta.durationMs, 0);
  const totalCost = evalNodes.reduce((s, { meta }) => s + meta.tokenCost, 0);
  const totalTurns = evalNodes.reduce((s, { meta }) => s + meta.turnCount, 0);

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
    .map(n => ({ node: n, meta: asEvalMeta(n.metadata) }))
    .filter(({ meta }) => meta.eval && meta.agentRole === agentRole);

  const now = Date.now();
  const recentCutoff = now - recentDays * 86400000;
  const baselineCutoff = now - baselineDays * 86400000;

  const recent = allEvals.filter(({ node }) => new Date(node.created_at).getTime() >= recentCutoff);
  const baseline = allEvals.filter(({ node }) => {
    const t = new Date(node.created_at).getTime();
    return t >= baselineCutoff && t < recentCutoff;
  });

  if (recent.length < 3 || baseline.length < 3) {
    return { completionRateDelta: 0, avgCostDelta: 0, avgTurnsDelta: 0, alert: false };
  }

  const recentCompletion = recent.filter(({ meta }) => meta.completed).length / recent.length;
  const baselineCompletion = baseline.filter(({ meta }) => meta.completed).length / baseline.length;

  const recentCost = recent.reduce((s, { meta }) => s + meta.tokenCost, 0) / recent.length;
  const baselineCost = baseline.reduce((s, { meta }) => s + meta.tokenCost, 0) / baseline.length;

  const recentTurns = recent.reduce((s, { meta }) => s + meta.turnCount, 0) / recent.length;
  const baselineTurns = baseline.reduce((s, { meta }) => s + meta.turnCount, 0) / baseline.length;

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
    .map(n => ({ node: n, meta: asEvalMeta(n.metadata) }))
    .filter(({ meta }) => meta.eval);

  if (agentRole) {
    evalNodes = evalNodes.filter(({ meta }) => meta.agentRole === agentRole);
  }

  return evalNodes.slice(0, limit).map(({ node, meta }) => {
    const metrics = node.content ? JSON.parse(node.content) as Record<string, unknown> : {};
    const pickNum = (k: string): number => {
      if (typeof meta[k as keyof EvalNodeMetadata] === "number") return meta[k as keyof EvalNodeMetadata] as number;
      return typeof metrics[k] === "number" ? metrics[k] as number : 0;
    };
    return {
      agentRole: meta.agentRole,
      runtime: meta.runtime,
      model: meta.model,
      sessionId: node.id.replace("eval:", ""),
      metrics: {
        completed: meta.completed,
        testsPassed: meta.testsPassed,
        prCreated: meta.prCreated,
        turnCount: pickNum("turnCount"),
        durationMs: pickNum("durationMs"),
        tokenCost: pickNum("tokenCost"),
        filesChanged: pickNum("filesChanged"),
        retryCount: pickNum("retryCount"),
      },
      timestamp: node.created_at,
    };
  });
}
