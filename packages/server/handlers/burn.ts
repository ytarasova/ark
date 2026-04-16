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
 * Returns the UTC offset in minutes for a given timezone at a specific Date.
 * Positive = east of UTC, negative = west of UTC.
 */
export function zoneOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtcMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") === 24 ? 0 : get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtcMs - at.getTime()) / 60000);
}

/**
 * Returns a Date representing midnight (00:00:00) in the given timezone
 * for the calendar day that `at` falls in within that timezone.
 */
export function zoneMidnight(tz: string, at: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const wallUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offset = zoneOffsetMinutes(tz, new Date(wallUtc));
  return new Date(wallUtc - offset * 60000);
}

/**
 * Returns a SQLite datetime modifier string (e.g. '+0 hours', '-4 hours')
 * to convert UTC timestamps stored in the DB to the local timezone wall-clock.
 */
export function zoneSqliteModifier(tz: string, at: Date): string {
  const offMin = zoneOffsetMinutes(tz, at);
  const hours = offMin / 60;
  const sign = hours >= 0 ? "+" : "-";
  return `${sign}${Math.abs(hours)} hours`;
}

/**
 * Compute ISO date range strings for a given period name, timezone-aware.
 */
export function getDateRange(
  period: BurnPeriod,
  tz: string | undefined,
): { start: string; end: string; tz: string } {
  const zone = tz ?? "UTC";
  const now = new Date();
  const end = now.toISOString();
  const todayZoneMidnight = zoneMidnight(zone, now);
  let start: Date;

  switch (period) {
    case "today":
      start = todayZoneMidnight;
      break;
    case "week":
      start = new Date(todayZoneMidnight.getTime() - 6 * 24 * 60 * 60 * 1000);
      break;
    case "30days":
      start = new Date(todayZoneMidnight.getTime() - 29 * 24 * 60 * 60 * 1000);
      break;
    case "month": {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric", month: "2-digit",
      }).formatToParts(now);
      const y = Number(parts.find((p) => p.type === "year")?.value);
      const m = Number(parts.find((p) => p.type === "month")?.value);
      const wallUtc = Date.UTC(y, m - 1, 1);
      const offset = zoneOffsetMinutes(zone, new Date(wallUtc));
      start = new Date(wallUtc - offset * 60000);
      break;
    }
    default:
      start = new Date(todayZoneMidnight.getTime() - 6 * 24 * 60 * 60 * 1000);
  }

  return { start: start.toISOString(), end, tz: zone };
}

export function registerBurnHandlers(router: Router, app: AppContext): void {
  router.handle("burn/summary", async (p) => {
    const { period, tz } = extract<{ period?: BurnPeriod; tz?: string }>(p, []);
    const per = period ?? "week";
    const dateRange = getDateRange(per, tz);
    const opts = {
      tenantId: "default",
      since: dateRange.start,
      until: dateRange.end,
      tz: dateRange.tz,
    };

    const overview = app.burn.getOverview(opts);
    const daily = app.burn.getDailyBreakdown(opts);
    const byProject = app.burn.getProjectBreakdown(opts);
    const byModel = app.burn.getModelBreakdown(opts);
    const byCategory = app.burn.getCategoryBreakdown(opts);
    const coreTools = app.burn.getToolBreakdown(opts);
    const mcpServers = app.burn.getMcpBreakdown(opts);
    const bashCommands = app.burn.getBashBreakdown(opts);
    const runtimeCoverage = app.burn.getRuntimeCoverage(opts);

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
      runtimeCoverage,
    };

    return response;
  });

  router.handle("burn/sync", async (p) => {
    const { force } = extract<{ force?: boolean }>(p, []);
    return syncBurn(app, { force });
  });
}
