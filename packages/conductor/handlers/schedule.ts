import type { Router } from "../router.js";
import type { AppContext } from "../../core/app.js";
import { extract } from "../validate.js";
import * as core from "../../core/index.js";
import type { ScheduleDeleteParams, ScheduleIdParams } from "../../types/index.js";

export function registerScheduleHandlers(router: Router, app: AppContext): void {
  // Every schedule RPC resolves the AppContext through `forTenant(ctx.tenantId)`
  // so the underlying core helpers (which read tenant from the session repo's
  // bound tenantId) scope reads + writes to the caller's tenant. Cross-tenant
  // IDs silently fall through to NOT_FOUND because the WHERE tenant_id clause
  // filters them out.
  router.handle("schedule/list", async (_p, _notify, ctx) => ({
    schedules: await core.listSchedules(app.forTenant(ctx.tenantId)),
  }));

  router.handle("schedule/create", async (p, _notify, ctx) => {
    const opts = extract<{
      cron: string;
      flow?: string;
      repo?: string;
      workdir?: string;
      summary?: string;
      compute_name?: string;
      group_name?: string;
    }>(p, ["cron"]);
    return { schedule: await core.createSchedule(app.forTenant(ctx.tenantId), opts) };
  });

  router.handle("schedule/delete", async (p, _notify, ctx) => {
    const { id } = extract<ScheduleDeleteParams>(p, ["id"]);
    return { ok: await core.deleteSchedule(app.forTenant(ctx.tenantId), id) };
  });

  router.handle("schedule/enable", async (p, _notify, ctx) => {
    const { id } = extract<ScheduleIdParams>(p, ["id"]);
    await core.enableSchedule(app.forTenant(ctx.tenantId), id, true);
    return { ok: true };
  });

  router.handle("schedule/disable", async (p, _notify, ctx) => {
    const { id } = extract<ScheduleIdParams>(p, ["id"]);
    await core.enableSchedule(app.forTenant(ctx.tenantId), id, false);
    return { ok: true };
  });
}
