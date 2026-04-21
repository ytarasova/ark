/**
 * Shared metrics + cost-tracking handlers.
 *
 * The privileged host-command handlers (`compute/kill-process`,
 * `compute/docker-logs`, `compute/docker-action`) are local-only and live in
 * `metrics-local.ts`. They're registered conditionally when
 * `app.mode.hostCommandCapability` is non-null.
 */

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
    const compute = await app.computes.get(resolved);
    if (!compute) return { snapshot: null };
    const provider = getProvider(compute.provider);
    if (!provider?.getMetrics) return { snapshot: null };
    const snapshot = await provider.getMetrics(compute);
    return { snapshot };
  });

  router.handle("costs/read", async () => {
    const sessions = await app.sessions.list({ limit: 500 });
    const { sessions: costs, total } = await getAllSessionCosts(app, sessions);
    return { costs, total };
  });

  // ── Universal cost tracking endpoints ──────────────────────────────────

  router.handle("costs/summary", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const groupBy = params.groupBy ?? "model";
    const since = params.since;
    const until = params.until;

    // tenantId is intentionally NOT forwarded from the client -- the
    // UsageRecorder enforces its own tenant scope. A remote caller cannot
    // query another tenant's costs by passing that tenant's id here.
    const summary = await app.usageRecorder.getSummary({ groupBy, since, until });
    const total = await app.usageRecorder.getTotalCost({ since, until });
    return { summary, total };
  });

  router.handle("costs/trend", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const days = params.days ?? 30;

    // tenantId is intentionally NOT forwarded from the client.
    const trend = await app.usageRecorder.getDailyTrend({ days });
    return { trend };
  });

  router.handle("costs/session", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    const sessionId = params.sessionId;
    if (!sessionId) throw new Error("sessionId required");

    // Double-check the session exists in the caller's tenant. getSessionCost
    // also filters by tenant, so this is defense-in-depth -- but also lets
    // us return 404-style errors for sessions that don't exist in this
    // tenant, instead of silently returning an empty cost record (which
    // could be used to probe session ids).
    const session = await app.sessions.get(sessionId);
    if (!session) throw new Error("Session not found");

    const result = await app.usageRecorder.getSessionCost(sessionId);
    return result;
  });

  router.handle("costs/record", async (p) => {
    const params = (p ?? {}) as Record<string, any>;
    if (!params.sessionId || !params.model || !params.provider) {
      throw new Error("sessionId, model, and provider are required");
    }
    // Verify the session belongs to the caller's tenant. app.sessions is
    // tenant-scoped; .get() returns null for sessions in other tenants,
    // which both prevents cross-tenant write attribution and hides the
    // existence of other tenants' sessions from enumerators.
    const session = await app.sessions.get(params.sessionId);
    if (!session) throw new Error("Session not found");
    // tenantId is intentionally NOT forwarded from the client -- the
    // UsageRecorder is tenant-scoped and will attribute the record to the
    // caller's tenant regardless.
    await app.usageRecorder.record({
      sessionId: params.sessionId,
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
