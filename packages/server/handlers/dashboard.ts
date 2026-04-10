import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { getAllSessionCosts, checkBudget } from "../../core/costs.js";

export function registerDashboardHandlers(router: Router, app: AppContext): void {
  router.handle("dashboard/summary", async () => {
    const sessions = app.sessions.list({ limit: 500 });

    // Fleet status counts
    const counts: Record<string, number> = {
      running: 0, waiting: 0, stopped: 0, failed: 0, completed: 0,
      ready: 0, archived: 0, total: sessions.length,
    };
    for (const s of sessions) {
      if (s.status in counts) counts[s.status]++;
    }

    // Cost summary
    const { sessions: costSessions, total: totalCost } = getAllSessionCosts(sessions);

    // Cost by model
    const byModel: Record<string, number> = {};
    for (const c of costSessions) {
      const model = c.model ?? "unknown";
      byModel[model] = (byModel[model] ?? 0) + c.cost;
    }

    // Time-bucketed costs (today, this week, this month)
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekStart = new Date(now.getTime() - now.getDay() * 86400000);
    weekStart.setHours(0, 0, 0, 0);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const todaySessions = sessions.filter(s => s.updated_at >= todayStart);
    const weekSessions = sessions.filter(s => s.updated_at >= weekStart.toISOString());
    const monthSessions = sessions.filter(s => s.updated_at >= monthStart);

    const todayCost = getAllSessionCosts(todaySessions).total;
    const weekCost = getAllSessionCosts(weekSessions).total;
    const monthCost = getAllSessionCosts(monthSessions).total;

    // Budget info
    const budgets = app.config.budgets ?? {};
    const budget = checkBudget(sessions, budgets);

    // Recent events (last 10 across all sessions)
    const recentEvents: any[] = [];
    // Get events from the most recently updated sessions
    const recentSessions = [...sessions]
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
      .slice(0, 20);
    for (const s of recentSessions) {
      const evts = app.events.list(s.id, { limit: 5 });
      for (const e of evts) {
        recentEvents.push({
          sessionId: s.id,
          sessionSummary: s.summary,
          type: e.type,
          data: e.data,
          created_at: e.created_at,
        });
      }
    }
    recentEvents.sort((a, b) => b.created_at.localeCompare(a.created_at));

    // Top cost sessions for charts
    const topCostSessions = costSessions.slice(0, 10).map(c => ({
      sessionId: c.sessionId,
      summary: c.summary,
      model: c.model,
      cost: c.cost,
    }));

    // System health: conductor is online if we got here
    const system = {
      conductor: true,
      router: app.config.router?.enabled ?? false,
    };

    // Active compute count
    const computes = app.computes.list();
    const activeCompute = computes.filter((c: any) => c.status === "running" || c.status === "provisioned").length;

    return {
      counts,
      costs: {
        total: totalCost,
        today: todayCost,
        week: weekCost,
        month: monthCost,
        byModel,
        budget,
      },
      recentEvents: recentEvents.slice(0, 10),
      topCostSessions,
      system,
      activeCompute,
    };
  });
}
