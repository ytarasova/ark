import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";

export function registerEvalHandlers(router: Router, app: AppContext): void {
  router.handle("eval/stats", async (p) => {
    const { agentRole } = extract<{ agentRole?: string }>(p, []);
    const { getAgentStats } = await import("../../core/knowledge/evals.js");

    if (agentRole) {
      return { stats: getAgentStats(app, agentRole) };
    }

    // Aggregate across all agents: collect unique roles from eval nodes
    const evalNodes = app.knowledge.listNodes({ type: "session" })
      .filter(n => (n.metadata as any).eval);

    const roles = new Set(evalNodes.map(n => (n.metadata as any).agentRole as string).filter(Boolean));

    if (roles.size === 0) {
      return { stats: { totalSessions: 0, completionRate: 0, avgDurationMs: 0, avgCost: 0, avgTurns: 0, testPassRate: 0, prRate: 0 } };
    }

    // Compute aggregate across all roles
    const completed = evalNodes.filter(n => (n.metadata as any).completed).length;
    const withTests = evalNodes.filter(n => (n.metadata as any).testsPassed !== null);
    const testsPassed = withTests.filter(n => (n.metadata as any).testsPassed).length;
    const withPR = evalNodes.filter(n => (n.metadata as any).prCreated).length;
    const totalDuration = evalNodes.reduce((s, n) => s + ((n.metadata as any).durationMs ?? 0), 0);
    const totalCost = evalNodes.reduce((s, n) => s + ((n.metadata as any).tokenCost ?? 0), 0);
    const totalTurns = evalNodes.reduce((s, n) => s + ((n.metadata as any).turnCount ?? 0), 0);
    const total = evalNodes.length;

    return {
      stats: {
        totalSessions: total,
        completionRate: total > 0 ? completed / total : 0,
        avgDurationMs: total > 0 ? totalDuration / total : 0,
        avgCost: total > 0 ? totalCost / total : 0,
        avgTurns: total > 0 ? totalTurns / total : 0,
        testPassRate: withTests.length > 0 ? testsPassed / withTests.length : 0,
        prRate: total > 0 ? withPR / total : 0,
      },
    };
  });

  router.handle("eval/drift", async (p) => {
    const { agentRole, recentDays } = extract<{ agentRole?: string; recentDays?: number }>(p, []);
    const { detectDrift } = await import("../../core/knowledge/evals.js");
    const drift = detectDrift(app, agentRole ?? "implementer", recentDays ?? 7);
    return { drift };
  });

  router.handle("eval/list", async (p) => {
    const { agentRole, limit } = extract<{ agentRole?: string; limit?: number }>(p, []);
    const { listEvals } = await import("../../core/knowledge/evals.js");
    const evals = listEvals(app, agentRole, limit ?? 20);
    return { evals };
  });
}
