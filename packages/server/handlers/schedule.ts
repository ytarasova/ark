import type { Router } from "../router.js";
import * as core from "../../core/index.js";

export function registerScheduleHandlers(router: Router): void {
  router.handle("schedule/list", async () => ({
    schedules: core.listSchedules(),
  }));

  router.handle("schedule/create", async (p) => ({
    schedule: core.createSchedule(p as any),
  }));

  router.handle("schedule/delete", async (p) => ({
    ok: core.deleteSchedule(p.id as string),
  }));

  router.handle("schedule/enable", async (p) => {
    core.enableSchedule(p.id as string, true);
    return { ok: true };
  });

  router.handle("schedule/disable", async (p) => {
    core.enableSchedule(p.id as string, false);
    return { ok: true };
  });
}
