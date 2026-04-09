/**
 * E2E tests for cron scheduling — full lifecycle through the database.
 *
 * Tests the complete schedule lifecycle: create, list, get, enable/disable,
 * cronMatches with specific dates, updateScheduleLastRun double-fire guard,
 * delete, and multi-schedule listing.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import {
  createSchedule, listSchedules, getSchedule, deleteSchedule,
  enableSchedule, updateScheduleLastRun, cronMatches,
} from "../index.js";
import { AppContext, setApp, clearApp, getApp } from "../app.js";

let app: AppContext;

beforeEach(async () => {
  if (app) { await app.shutdown(); clearApp(); }
  app = AppContext.forTest(); setApp(app); await app.boot();
});

afterAll(async () => {
  if (app) { await app.shutdown(); clearApp(); }
});

// -- Full lifecycle -----------------------------------------------------------

describe("schedule E2E lifecycle", () => {
  it("create -> get -> disable -> verify disabled -> delete -> verify gone", () => {
    // Create
    const sched = createSchedule(getApp(), { cron: "* * * * *", summary: "every minute" });
    expect(sched.id).toMatch(/^sched-/);
    expect(sched.cron).toBe("* * * * *");
    expect(sched.enabled).toBe(true);
    expect(sched.summary).toBe("every minute");

    // Get it back
    const fetched = getSchedule(getApp(), sched.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(sched.id);
    expect(fetched!.cron).toBe("* * * * *");

    // Disable
    enableSchedule(getApp(), sched.id, false);
    const disabled = getSchedule(getApp(), sched.id);
    expect(disabled!.enabled).toBe(false);

    // Delete
    const deleted = deleteSchedule(getApp(), sched.id);
    expect(deleted).toBe(true);

    // Verify gone
    expect(getSchedule(getApp(), sched.id)).toBeNull();
  });

  it("re-enable a disabled schedule", () => {
    const sched = createSchedule(getApp(), { cron: "0 9 * * 1-5" });
    enableSchedule(getApp(), sched.id, false);
    expect(getSchedule(getApp(), sched.id)!.enabled).toBe(false);

    enableSchedule(getApp(), sched.id, true);
    expect(getSchedule(getApp(), sched.id)!.enabled).toBe(true);
  });
});

// -- cronMatches with specific dates ------------------------------------------

describe("cronMatches E2E with specific dates", () => {
  it("matches every minute for any date", () => {
    expect(cronMatches("* * * * *", new Date("2026-03-25T10:42:00"))).toBe(true);
    expect(cronMatches("* * * * *", new Date("2026-12-31T23:59:00"))).toBe(true);
  });

  it("0 9 * * 1-5 matches weekday mornings only", () => {
    // 2026-03-25 is a Wednesday
    expect(cronMatches("0 9 * * 1-5", new Date("2026-03-25T09:00:00"))).toBe(true);
    // 2026-03-22 is a Sunday
    expect(cronMatches("0 9 * * 1-5", new Date("2026-03-22T09:00:00"))).toBe(false);
  });

  it("30 14 25 12 * matches Christmas 2:30 PM", () => {
    expect(cronMatches("30 14 25 12 *", new Date("2026-12-25T14:30:00"))).toBe(true);
    expect(cronMatches("30 14 25 12 *", new Date("2026-12-24T14:30:00"))).toBe(false);
  });

  it("*/15 * * * * matches quarter hours", () => {
    expect(cronMatches("*/15 * * * *", new Date("2026-01-01T00:00:00"))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date("2026-01-01T00:15:00"))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date("2026-01-01T00:30:00"))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date("2026-01-01T00:45:00"))).toBe(true);
    expect(cronMatches("*/15 * * * *", new Date("2026-01-01T00:07:00"))).toBe(false);
    expect(cronMatches("*/15 * * * *", new Date("2026-01-01T00:22:00"))).toBe(false);
  });

  it("0 0 1 1 * matches New Year midnight", () => {
    expect(cronMatches("0 0 1 1 *", new Date("2026-01-01T00:00:00"))).toBe(true);
    expect(cronMatches("0 0 1 1 *", new Date("2026-02-01T00:00:00"))).toBe(false);
  });

  it("0,30 8-17 * * * matches on-the-hour and half-hour during business hours", () => {
    expect(cronMatches("0,30 8-17 * * *", new Date("2026-03-25T08:00:00"))).toBe(true);
    expect(cronMatches("0,30 8-17 * * *", new Date("2026-03-25T12:30:00"))).toBe(true);
    expect(cronMatches("0,30 8-17 * * *", new Date("2026-03-25T17:00:00"))).toBe(true);
    expect(cronMatches("0,30 8-17 * * *", new Date("2026-03-25T07:30:00"))).toBe(false);
    expect(cronMatches("0,30 8-17 * * *", new Date("2026-03-25T18:00:00"))).toBe(false);
    expect(cronMatches("0,30 8-17 * * *", new Date("2026-03-25T12:15:00"))).toBe(false);
  });
});

// -- updateScheduleLastRun double-fire guard ----------------------------------

describe("updateScheduleLastRun prevents double-fire", () => {
  it("last_run is null initially, set after updateScheduleLastRun", () => {
    const sched = createSchedule(getApp(), { cron: "* * * * *" });
    expect(sched.last_run).toBeNull();

    updateScheduleLastRun(getApp(), sched.id);
    const updated = getSchedule(getApp(), sched.id)!;
    expect(updated.last_run).toBeTruthy();
    expect(updated.last_run).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("two rapid updateScheduleLastRun calls produce same-minute timestamps", () => {
    const sched = createSchedule(getApp(), { cron: "* * * * *" });

    updateScheduleLastRun(getApp(), sched.id);
    const first = getSchedule(getApp(), sched.id)!.last_run!;

    updateScheduleLastRun(getApp(), sched.id);
    const second = getSchedule(getApp(), sched.id)!.last_run!;

    // Both timestamps are in the same minute (within a second or two of each other)
    const firstMinute = first.slice(0, 16); // "2026-03-25T10:42"
    const secondMinute = second.slice(0, 16);
    expect(firstMinute).toBe(secondMinute);
  });

  it("last_run allows checking if schedule already fired this minute", () => {
    const sched = createSchedule(getApp(), { cron: "* * * * *" });

    // Simulate the conductor's double-fire guard logic:
    // Before firing, check if last_run is in the current minute
    const before = getSchedule(getApp(), sched.id)!;
    expect(before.last_run).toBeNull(); // never fired => should fire

    updateScheduleLastRun(getApp(), sched.id);
    const after = getSchedule(getApp(), sched.id)!;
    const lastRunMinute = after.last_run!.slice(0, 16);
    const nowMinute = new Date().toISOString().slice(0, 16);
    expect(lastRunMinute).toBe(nowMinute); // same minute => do not fire again
  });
});

// -- Multiple schedules -------------------------------------------------------

describe("multiple schedules", () => {
  it("listSchedules returns all created schedules", () => {
    createSchedule(getApp(), { cron: "0 2 * * *", summary: "nightly-backup" });
    createSchedule(getApp(), { cron: "0 9 * * 1", summary: "weekly-report" });
    createSchedule(getApp(), { cron: "*/5 * * * *", summary: "health-check" });

    const list = listSchedules(getApp());
    expect(list.length).toBe(3);

    const summaries = list.map((s) => s.summary);
    expect(summaries).toContain("nightly-backup");
    expect(summaries).toContain("weekly-report");
    expect(summaries).toContain("health-check");
  });

  it("deleting one schedule does not affect others", () => {
    const a = createSchedule(getApp(), { cron: "0 1 * * *", summary: "a" });
    const b = createSchedule(getApp(), { cron: "0 2 * * *", summary: "b" });
    const c = createSchedule(getApp(), { cron: "0 3 * * *", summary: "c" });

    deleteSchedule(getApp(), b.id);

    const list = listSchedules(getApp());
    expect(list.length).toBe(2);
    expect(list.map((s) => s.summary)).toContain("a");
    expect(list.map((s) => s.summary)).toContain("c");
    expect(getSchedule(getApp(), b.id)).toBeNull();
    expect(getSchedule(getApp(), a.id)).not.toBeNull();
    expect(getSchedule(getApp(), c.id)).not.toBeNull();
  });

  it("each schedule has a unique id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const s = createSchedule(getApp(), { cron: "* * * * *", summary: `s-${i}` });
      ids.add(s.id);
    }
    expect(ids.size).toBe(10);
  });

  it("schedules with different flows and optional fields", () => {
    const s1 = createSchedule(getApp(), {
      cron: "0 8 * * *",
      flow: "deploy",
      repo: "org/api",
      compute_name: "prod",
      group_name: "deployments",
    });
    const s2 = createSchedule(getApp(), {
      cron: "0 22 * * *",
      flow: "backup",
      workdir: "/mnt/backups",
    });

    expect(s1.flow).toBe("deploy");
    expect(s1.repo).toBe("org/api");
    expect(s1.compute_name).toBe("prod");
    expect(s1.group_name).toBe("deployments");

    expect(s2.flow).toBe("backup");
    expect(s2.workdir).toBe("/mnt/backups");
    expect(s2.repo).toBeNull();
  });
});
