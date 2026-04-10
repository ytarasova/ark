import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { getProvider } from "../../compute/index.js";
import { getAllSessionCosts } from "../../core/observability/costs.js";
import type { MetricsSnapshotParams } from "../../types/index.js";

export function registerMetricsHandlers(router: Router, app: AppContext): void {
  router.handle("metrics/snapshot", async (p) => {
    const { computeName } = extract<MetricsSnapshotParams>(p, []);
    const resolved = computeName ?? "local";
    const compute = app.computes.get(resolved);
    if (!compute) return { snapshot: null };
    const provider = getProvider(compute.provider);
    if (!provider?.getMetrics) return { snapshot: null };
    const snapshot = await provider.getMetrics(compute);
    return { snapshot };
  });

  router.handle("costs/read", async () => {
    const sessions = app.sessions.list({ limit: 500 });
    const { sessions: costs, total } = getAllSessionCosts(sessions);
    return { costs, total };
  });

  // ── Universal cost tracking endpoints ──────────────────────────────────

  router.handle("costs/summary", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const groupBy = params.groupBy ?? "model";
    const tenantId = params.tenantId;
    const since = params.since;
    const until = params.until;

    const summary = app.usageRecorder.getSummary({ groupBy, tenantId, since, until });
    const total = app.usageRecorder.getTotalCost({ tenantId, since, until });
    return { summary, total };
  });

  router.handle("costs/trend", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const tenantId = params.tenantId;
    const days = params.days ?? 30;

    const trend = app.usageRecorder.getDailyTrend({ tenantId, days });
    return { trend };
  });

  router.handle("costs/session", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const sessionId = params.sessionId;
    if (!sessionId) throw new Error("sessionId required");

    const result = app.usageRecorder.getSessionCost(sessionId);
    return result;
  });

  router.handle("costs/record", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    if (!params.sessionId || !params.model || !params.provider) {
      throw new Error("sessionId, model, and provider are required");
    }
    app.usageRecorder.record({
      sessionId: params.sessionId,
      tenantId: params.tenantId,
      model: params.model,
      provider: params.provider,
      runtime: params.runtime,
      agentRole: params.agentRole,
      usage: {
        input_tokens: params.input_tokens ?? 0,
        output_tokens: params.output_tokens ?? 0,
        cache_read_tokens: params.cache_read_tokens ?? 0,
        cache_write_tokens: params.cache_write_tokens ?? 0,
      },
      source: params.source ?? "api",
    });
    return { ok: true };
  });
}
