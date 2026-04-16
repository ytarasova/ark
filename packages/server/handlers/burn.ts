/**
 * RPC handlers for burn dashboard endpoints.
 * burn/summary -- returns aggregated burn data for a given time period.
 * burn/sync -- triggers a manual burn sync from transcripts.
 */

import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import { syncBurn } from "../../core/observability/burn/sync.js";
import type { BurnPeriod, BurnSummaryResponse } from "../../core/observability/burn/types.js";

/**
 * Compute ISO date range strings for a given period name.
 */
function getDateRange(period: BurnPeriod): { start: string; end: string } {
  const now = new Date();
  const end = now.toISOString();
  let start: Date;

  switch (period) {
    case "today": {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    }
    case "week": {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case "30days": {
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      start.setHours(0, 0, 0, 0);
      break;
    }
    case "month": {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    }
    default: {
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      start.setHours(0, 0, 0, 0);
    }
  }

  return { start: start.toISOString(), end };
}

export function registerBurnHandlers(router: Router, app: AppContext): void {
  router.handle("burn/summary", async (p) => {
    const { period } = extract<{ period?: BurnPeriod }>(p, []);
    const per = period ?? "week";
    const dateRange = getDateRange(per);
    const opts = {
      tenantId: "default",
      since: dateRange.start,
      until: dateRange.end,
    };

    const overview = app.burn.getOverview(opts);
    const daily = app.burn.getDailyBreakdown(opts);
    const byProject = app.burn.getProjectBreakdown(opts);
    const byModel = app.burn.getModelBreakdown(opts);
    const byCategory = app.burn.getCategoryBreakdown(opts);
    const coreTools = app.burn.getToolBreakdown(opts);
    const mcpServers = app.burn.getMcpBreakdown(opts);
    const bashCommands = app.burn.getBashBreakdown(opts);

    const response: BurnSummaryResponse = {
      period: per,
      dateRange,
      overview,
      daily,
      byProject,
      byModel,
      byCategory,
      coreTools,
      mcpServers,
      bashCommands,
    };

    return response;
  });

  router.handle("burn/sync", async (p) => {
    const { force } = extract<{ force?: boolean }>(p, []);
    return syncBurn(app, { force });
  });
}
