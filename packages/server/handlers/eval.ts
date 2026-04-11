import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";

export function registerEvalHandlers(router: Router, app: AppContext): void {
  router.handle("eval/stats", async (p) => {
    const { agentRole } = extract<{ agentRole?: string }>(p, []);
    const { getAgentStats } = await import("../../core/knowledge/evals.js");
    return { stats: getAgentStats(app, agentRole) };
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
