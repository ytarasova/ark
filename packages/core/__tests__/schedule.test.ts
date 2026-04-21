/**
 * Tests for schedules table -- CRUD operations and cron matching.
 */

import { describe, it, expect } from "bun:test";
import {
  createSchedule,
  listSchedules,
  getSchedule,
  deleteSchedule,
  enableSchedule,
  updateScheduleLastRun,
  cronMatches,
} from "../index.js";
import { withTestContext } from "./test-helpers.js";
import { getApp } from "./test-helpers.js";

withTestContext();

describe("schedule CRUD", () => {
  it("createSchedule returns schedule with ID", async () => {
    const sched = await createSchedule(getApp(), { cron: "0 2 * * *" });
    expect(sched.id).toMatch(/^sched-/);
    expect(sched.cron).toBe("0 2 * * *");
    expect(sched.flow).toBe("bare");
    expect(sched.enabled).toBe(true);
    expect(sched.created_at).toBeTruthy();
  });

  it("listSchedules returns created schedules", async () => {
    await createSchedule(getApp(), { cron: "0 2 * * *", summary: "nightly" });
    await createSchedule(getApp(), { cron: "0 9 * * 1", summary: "weekly" });
    const list = await listSchedules(getApp());
    expect(list.length).toBe(2);
    const summaries = list.map((s) => s.summary);
    expect(summaries).toContain("nightly");
    expect(summaries).toContain("weekly");
  });

  it("getSchedule by ID", async () => {
    const sched = await createSchedule(getApp(), { cron: "*/5 * * * *", repo: "my/repo" });
    const found = await getSchedule(getApp(), sched.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(sched.id);
    expect(found!.repo).toBe("my/repo");
  });

  it("getSchedule returns null for missing ID", async () => {
    const found = await getSchedule(getApp(), "sched-nonexistent");
    expect(found).toBeNull();
  });

  it("deleteSchedule removes it", async () => {
    const sched = await createSchedule(getApp(), { cron: "0 0 * * *" });
    expect(await deleteSchedule(getApp(), sched.id)).toBe(true);
    expect(await getSchedule(getApp(), sched.id)).toBeNull();
  });

  it("deleteSchedule returns false for missing ID", async () => {
    expect(await deleteSchedule(getApp(), "sched-nonexistent")).toBe(false);
  });

  it("enableSchedule toggles enabled flag", async () => {
    const sched = await createSchedule(getApp(), { cron: "0 0 * * *" });
    expect(sched.enabled).toBe(true);

    await enableSchedule(getApp(), sched.id, false);
    expect((await getSchedule(getApp(), sched.id))!.enabled).toBe(false);

    await enableSchedule(getApp(), sched.id, true);
    expect((await getSchedule(getApp(), sched.id))!.enabled).toBe(true);
  });

  it("updateScheduleLastRun updates timestamp", async () => {
    const sched = await createSchedule(getApp(), { cron: "0 0 * * *" });
    expect(sched.last_run).toBeNull();

    await updateScheduleLastRun(getApp(), sched.id);
    const updated = (await getSchedule(getApp(), sched.id))!;
    expect(updated.last_run).toBeTruthy();
    expect(updated.last_run).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("createSchedule stores all optional fields", async () => {
    const sched = await createSchedule(getApp(), {
      cron: "0 9 * * 1-5",
      flow: "deploy",
      repo: "org/repo",
      workdir: "/tmp/work",
      summary: "weekday deploy",
      compute_name: "prod-box",
      group_name: "deploys",
    });
    expect(sched.flow).toBe("deploy");
    expect(sched.repo).toBe("org/repo");
    expect(sched.workdir).toBe("/tmp/work");
    expect(sched.summary).toBe("weekday deploy");
    expect(sched.compute_name).toBe("prod-box");
    expect(sched.group_name).toBe("deploys");
  });
});

describe("cronMatches", () => {
  it("* * * * * always matches", () => {
    expect(cronMatches("* * * * *")).toBe(true);
    expect(cronMatches("* * * * *", new Date("2025-06-15T08:30:00"))).toBe(true);
  });

  it("0 2 * * * matches 2:00 AM", () => {
    const d = new Date("2025-01-15T02:00:00");
    expect(cronMatches("0 2 * * *", d)).toBe(true);
  });

  it("0 2 * * * does not match 3:00 AM", () => {
    const d = new Date("2025-01-15T03:00:00");
    expect(cronMatches("0 2 * * *", d)).toBe(false);
  });

  it("30 14 * * 1 matches Monday 2:30 PM", () => {
    // 2025-01-13 is a Monday
    const d = new Date("2025-01-13T14:30:00");
    expect(d.getDay()).toBe(1); // sanity check: Monday
    expect(cronMatches("30 14 * * 1", d)).toBe(true);
  });

  it("30 14 * * 1 does not match Tuesday 2:30 PM", () => {
    // 2025-01-14 is a Tuesday
    const d = new Date("2025-01-14T14:30:00");
    expect(cronMatches("30 14 * * 1", d)).toBe(false);
  });

  it("*/5 * * * * matches minutes 0, 5, 10...", () => {
    expect(cronMatches("*/5 * * * *", new Date("2025-01-01T00:00:00"))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date("2025-01-01T00:05:00"))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date("2025-01-01T00:10:00"))).toBe(true);
    expect(cronMatches("*/5 * * * *", new Date("2025-01-01T00:03:00"))).toBe(false);
    expect(cronMatches("*/5 * * * *", new Date("2025-01-01T00:07:00"))).toBe(false);
  });

  it("0 0 1 * * matches first of month midnight", () => {
    const d = new Date("2025-03-01T00:00:00");
    expect(cronMatches("0 0 1 * *", d)).toBe(true);
  });

  it("0 0 1 * * does not match second of month", () => {
    const d = new Date("2025-03-02T00:00:00");
    expect(cronMatches("0 0 1 * *", d)).toBe(false);
  });

  it("1,15,30 * * * * matches minutes 1, 15, 30", () => {
    expect(cronMatches("1,15,30 * * * *", new Date("2025-01-01T00:01:00"))).toBe(true);
    expect(cronMatches("1,15,30 * * * *", new Date("2025-01-01T00:15:00"))).toBe(true);
    expect(cronMatches("1,15,30 * * * *", new Date("2025-01-01T00:30:00"))).toBe(true);
    expect(cronMatches("1,15,30 * * * *", new Date("2025-01-01T00:02:00"))).toBe(false);
  });

  it("0 9-17 * * * matches 9 AM to 5 PM", () => {
    expect(cronMatches("0 9-17 * * *", new Date("2025-01-01T09:00:00"))).toBe(true);
    expect(cronMatches("0 9-17 * * *", new Date("2025-01-01T12:00:00"))).toBe(true);
    expect(cronMatches("0 9-17 * * *", new Date("2025-01-01T17:00:00"))).toBe(true);
    expect(cronMatches("0 9-17 * * *", new Date("2025-01-01T08:00:00"))).toBe(false);
    expect(cronMatches("0 9-17 * * *", new Date("2025-01-01T18:00:00"))).toBe(false);
  });

  it("invalid cron returns false", () => {
    expect(cronMatches("not a cron")).toBe(false);
    expect(cronMatches("* * *")).toBe(false);
    expect(cronMatches("")).toBe(false);
  });
});
