/**
 * Background polling loops started with the conductor HTTP server.
 *
 * All four pollers share the same cadence pattern: a timer fires every
 * POLL_INTERVAL_MS, the callback is guarded by `safeAsync` so a single
 * transient failure doesn't bring down the interval. Returns an array of
 * timer handles so the caller can `clearInterval` on shutdown.
 */

import type { AppContext } from "../../app.js";
import { safeAsync } from "../../safe.js";
import { listSchedules, cronMatches, updateScheduleLastRun } from "../../schedule.js";
import { pollPRReviews } from "../../integrations/pr-poller.js";
import { pollPRMerges } from "../../integrations/pr-merge-poller.js";
import { pollIssues } from "../../integrations/issue-poller.js";

/** Interval between schedule and PR review poll ticks. */
const POLL_INTERVAL_MS = 60_000;

/** PR merge poller runs faster -- merge blocks flow completion. */
const MERGE_POLL_INTERVAL_MS = 30_000;

export interface PollerOptions {
  issueLabel?: string;
  issueAutoDispatch?: boolean;
}

/**
 * Start all conductor background pollers. Returns the set of timer handles
 * so the caller can clear them on shutdown.
 */
export function startPollers(app: AppContext, opts: PollerOptions): Array<ReturnType<typeof setInterval>> {
  const timers: Array<ReturnType<typeof setInterval>> = [];

  // Schedule poller -- check every 60 seconds
  timers.push(setInterval(() => safeAsync("schedule polling", () => tickSchedules(app)), POLL_INTERVAL_MS));

  // PR review poller - check every 60 seconds
  timers.push(setInterval(() => safeAsync("PR review polling", () => pollPRReviews(app)), POLL_INTERVAL_MS));

  // PR merge poller - check every 30 seconds (blocks flow completion, needs faster checks)
  timers.push(setInterval(() => safeAsync("PR merge polling", () => pollPRMerges(app)), MERGE_POLL_INTERVAL_MS));

  // Issue poller - only start if a label is configured
  if (opts.issueLabel) {
    const issueOpts = { label: opts.issueLabel, autoDispatch: opts.issueAutoDispatch };
    safeAsync("issue polling: initial", () => pollIssues(app, issueOpts));
    timers.push(setInterval(() => safeAsync("issue polling", () => pollIssues(app, issueOpts)), POLL_INTERVAL_MS));
  }

  return timers;
}

/**
 * Run a single tick of the schedule poller. Extracted so the interval
 * callback stays thin.
 */
async function tickSchedules(app: AppContext): Promise<void> {
  const schedules = (await listSchedules(app)).filter((s) => s.enabled);
  const now = new Date();
  for (const sched of schedules) {
    if (!cronMatches(sched.cron, now)) continue;
    if (sched.last_run) {
      const lastRun = new Date(sched.last_run);
      if (
        lastRun.getMinutes() === now.getMinutes() &&
        lastRun.getHours() === now.getHours() &&
        lastRun.getDate() === now.getDate()
      )
        continue;
    }
    await safeAsync(`scheduled dispatch for ${sched.id}`, async () => {
      const s = await app.sessionLifecycle.start({
        summary: sched.summary ?? `Scheduled: ${sched.id}`,
        repo: sched.repo ?? undefined,
        workdir: sched.workdir ?? undefined,
        flow: sched.flow,
        compute_name: sched.compute_name ?? undefined,
        group_name: sched.group_name ?? undefined,
      });
      await app.dispatchService.dispatch(s.id);
      await updateScheduleLastRun(app, sched.id);
      await app.events.log(s.id, "scheduled_dispatch", {
        actor: "scheduler",
        data: { schedule_id: sched.id, cron: sched.cron },
      });
    });
  }
}
