/**
 * Costs RPC handlers -- backfill + structured export.
 *
 * Complements the existing `costs/read`, `costs/summary`, `costs/trend`,
 * `costs/session`, and `costs/record` handlers registered via
 * `metrics-local.ts`. This file adds the two surfaces that previously
 * reached into a local AppContext from the CLI:
 *
 *   - costs/sync    backfill usage_records from on-disk transcripts; the
 *                   transcripts live on the daemon host, so this belongs on
 *                   the daemon side
 *   - costs/export  structured export of per-session cost rows (JSON
 *                   friendly). Returns data only; CLI renders CSV locally.
 *
 * Tenant scoping: both ops go through `resolveTenantApp(ctx)` so each caller
 * only sees sessions inside their tenant.
 *
 * Local-by-nature carve-outs (stay on the CLI side):
 *   - `costs-export --format csv` to a local file: the non-JSON flavour
 *     writes a CSV using `exportCostsCsv()`. The CLI can either (a) take
 *     the structured rows from `costs/export` and format CSV itself, or
 *     (b) keep calling `core.exportCostsCsv()` in-process. We do (a) --
 *     the CLI now formats CSV from the structured rows, and the CSV path
 *     therefore also works over --server.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { syncCosts, getAllSessionCosts } from "../../core/observability/costs.js";

function resolveTenantApp(app: AppContext, ctx: { tenantId?: string | null }): AppContext {
  const tenantId = ctx.tenantId ?? app.tenantId ?? app.config.authSection.defaultTenant;
  return tenantId ? app.forTenant(tenantId) : app;
}

export function registerCostsAdminHandlers(router: Router, app: AppContext): void {
  router.handle("costs/sync", async (_p, _notify, ctx) => {
    const scoped = resolveTenantApp(app, ctx);
    const { synced, skipped } = await syncCosts(scoped);
    return { ok: true, synced, skipped };
  });

  router.handle("costs/export", async (p, _notify, ctx) => {
    const { limit } = (p ?? {}) as { limit?: number };
    const scoped = resolveTenantApp(app, ctx);
    const sessions = await scoped.sessions.list({ limit: typeof limit === "number" ? limit : 500 });
    const { sessions: rows, total } = await getAllSessionCosts(scoped, sessions);
    // Flatten to a JSON-friendly row shape so clients don't need the core types.
    return {
      total,
      rows: rows.map((r) => ({
        sessionId: r.sessionId,
        summary: r.summary,
        model: r.model,
        cost: r.cost,
        input_tokens: r.usage?.input_tokens ?? 0,
        output_tokens: r.usage?.output_tokens ?? 0,
        cache_read_tokens: r.usage?.cache_read_tokens ?? 0,
        cache_write_tokens: r.usage?.cache_write_tokens ?? 0,
      })),
    };
  });
}
