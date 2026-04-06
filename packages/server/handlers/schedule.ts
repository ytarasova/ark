import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import type {
  ScheduleDeleteParams,
  ScheduleIdParams,
} from "../../types/index.js";

export function registerScheduleHandlers(router: Router, app: AppContext): void {
  router.handle("schedule/list", async () => ({
    schedules: core.listSchedules(),
  }));

  router.handle("schedule/create", async (p) => ({
    schedule: core.createSchedule(p as any),
  }));

  router.handle("schedule/delete", async (p) => {
    const { id } = extract<ScheduleDeleteParams>(p, ["id"]);
    return { ok: core.deleteSchedule(id) };
  });

  router.handle("schedule/enable", async (p) => {
    const { id } = extract<ScheduleIdParams>(p, ["id"]);
    core.enableSchedule(id, true);
    return { ok: true };
  });

  router.handle("schedule/disable", async (p) => {
    const { id } = extract<ScheduleIdParams>(p, ["id"]);
    core.enableSchedule(id, false);
    return { ok: true };
  });
}
